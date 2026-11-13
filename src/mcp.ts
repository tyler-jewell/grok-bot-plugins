import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
  GroupFullError,
  GroupGoneError,
  GroupNotFoundError,
  UnauthorizedError,
  type HeartbeatIn,
} from "./group";
import { runHealthcheck } from "./health";
import { clientIp, hashIp, rateLimit } from "./rate-limit";
import { MCP_INSTRUCTIONS, SKILL_NAMES, SKILLS, type SkillName } from "./skills.generated";
import { randomToken } from "./tokens";

/**
 * Phase 1 auth is unguessable group and member tokens passed as tool arguments
 * (no PII). Tokens are stored as SHA-256 hashes in the group's Durable Object.
 *
 * OAuth upgrade path (Phase 2+): wrap this handler in OAuthResourceServer from
 * @cloudflare/workers-oauth-provider, issue per-user tokens, and read identity
 * with getMcpAuthContext() instead of (or in addition to) member_token args.
 * Persist group membership against the OAuth subject, not the MCP session —
 * createMcpHandler is stateless and has no session store.
 */

function toolText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : "internal error";
  const name = err instanceof Error ? err.name : "";
  let code = "error";
  if (err instanceof GroupGoneError || name === "GroupGoneError" || message === "group expired" || message === "group deleted" || /no such table/i.test(message)) {
    code = "gone";
  } else if (err instanceof GroupNotFoundError || name === "GroupNotFoundError" || message === "group not found") {
    code = "not_found";
  } else if (err instanceof UnauthorizedError || name === "UnauthorizedError" || message === "unauthorized" || message.startsWith("invite") || message.includes("only the creator")) {
    code = "unauthorized";
  } else if (err instanceof GroupFullError || name === "GroupFullError" || message.includes("group is full")) {
    code = "full";
  }
  const publicMessage = code === "gone" && /no such table/i.test(message) ? "group deleted" : message;
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message: publicMessage }) }],
  };
}

function stub(env: Env, groupToken: string) {
  return env.GROUP.get(env.GROUP.idFromName(groupToken));
}

function urls(env: Env, groupToken: string, opts?: { inviteToken?: string; memberToken?: string }) {
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return {
    host_url: `${base}/g/${groupToken}`,
    mcp_url: `${base}/mcp`,
    invite_url: opts?.inviteToken ? `${base}/g/${groupToken}?invite=${opts.inviteToken}` : undefined,
    member_map_url: opts?.memberToken ? `${base}/g/${groupToken}#t=${opts.memberToken}` : undefined,
  };
}

const SKILL_TITLES: Record<SkillName, { title: string; description: string }> = {
  healthcheck: {
    title: "SkiHerd healthcheck skill",
    description: "Verify the SkiHerd MCP server and its backend are up before acting on a group. Run this first.",
  },
  setup: {
    title: "SkiHerd setup skill",
    description:
      "Walk a human through SkiHerd after healthcheck passes: consent, location once, create or join a group, first heartbeat, map link, and a 5-minute cadence.",
  },
};

function registerSkills(server: McpServer) {
  for (const name of SKILL_NAMES) {
    const meta = SKILL_TITLES[name];
    const text = SKILLS[name];
    server.registerPrompt(name, { title: meta.title, description: meta.description }, () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
    }));
    server.registerResource(
      name,
      `skiherd://skills/${name}`,
      { title: meta.title, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, text }] }),
    );
  }
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "skiherd", version: "0.2.0" }, { instructions: MCP_INSTRUCTIONS });

      registerSkills(server);

      server.registerTool(
        "healthcheck",
        {
          description:
            "Check that the SkiHerd Worker, Durable Objects, storage, alarms, map site, OSM data, and rate limiter are up. Call this first, every session, before creating or joining a group. Returns structured pass/fail per component and advice on failure.",
          inputSchema: {},
        },
        async () => {
          try {
            return toolText(await runHealthcheck(env, request));
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "get_skill",
        {
          description:
            "Return a SkiHerd skill as markdown. Use this if your client does not support MCP prompts or resources. Skills are also available as prompts (healthcheck, setup) and as skiherd://skills/{name} resources.",
          inputSchema: {
            name: z.enum(["healthcheck", "setup"]).describe("Which skill to return."),
          },
        },
        async ({ name }) => ({
          content: [{ type: "text" as const, text: SKILLS[name] }],
        }),
      );

      server.registerTool(
        "create_group",
        {
          description:
            "Create a SkiHerd group. Returns a group token, a host member token, and a map URL. The group and all of its data are deleted automatically 24 hours after creation. No personal data is required. Cap of 10 members. Run healthcheck first.",
          inputSchema: { host_name: z.string().min(1).max(40).describe("Display name for the host (no email or phone).") },
        },
        async ({ host_name }) => {
          try {
            const ip = clientIp(request);
            const limit = Number(env.CREATE_GROUP_PER_IP_PER_HOUR ?? 5);
            const rl = await rateLimit(caches.default, `create:${await hashIp(ip)}`, limit, 60 * 60 * 1000);
            if (!rl.ok) return toolError(new Error(`rate limited, retry in ${rl.retryAfterSec}s`));
            const groupToken = randomToken(32);
            const created = await stub(env, groupToken).create(host_name);
            return toolText({
              ...created,
              ...urls(env, created.group_token, { memberToken: created.member_token }),
              note: "Hosted free by Tyler Jewell. Bare minimum. No data is kept. Everything in this group is deleted 24 hours after creation. Do not share member tokens. This service is not affiliated with Winter Park Resort.",
            });
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "create_invite",
        {
          description:
            "Create an opaque, expiring invite token for a group. Default: single use, one hour, cannot exceed remaining seats (max 10 members).",
          inputSchema: {
            group_token: z.string(),
            member_token: z.string(),
            ttl_ms: z.number().int().positive().optional(),
            max_uses: z.number().int().positive().max(10).optional(),
          },
        },
        async ({ group_token, member_token, ttl_ms, max_uses }) => {
          try {
            const inv = await stub(env, group_token).createInvite(member_token, { ttl_ms, max_uses });
            return toolText({ ...inv, ...urls(env, group_token, { inviteToken: inv.invite_token }) });
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "join_group",
        {
          description: "Join a group with an invite token and a display name (no email or phone). Returns a member token.",
          inputSchema: {
            group_token: z.string(),
            invite_token: z.string(),
            display_name: z.string().min(1).max(40),
          },
        },
        async ({ group_token, invite_token, display_name }) => {
          try {
            const joined = await stub(env, group_token).join(invite_token, display_name);
            return toolText({ ...joined, group_token, ...urls(env, group_token, { memberToken: joined.member_token }) });
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "post_heartbeat",
        {
          description:
            "Post one location or a batch of locations for the authenticated member. Prefer a batch of on-device fixes over a single 5-minute point. Do not send names, emails, or other personal data — only the member token and coordinates.",
          inputSchema: {
            group_token: z.string(),
            member_token: z.string(),
            heartbeats: z
              .array(
                z.object({
                  ts: z.string(),
                  lat: z.number(),
                  lon: z.number(),
                  alt_m: z.number().nullable().optional(),
                  accuracy_m: z.number().nullable().optional(),
                  speed_mps: z.number().nullable().optional(),
                  heading_deg: z.number().nullable().optional(),
                  battery_pct: z.number().nullable().optional(),
                  activity: z.string().nullable().optional(),
                  place: z.string().nullable().optional(),
                  lift_or_trail: z.string().nullable().optional(),
                  difficulty: z.string().nullable().optional(),
                }),
              )
              .min(1)
              .max(500),
          },
        },
        async ({ group_token, member_token, heartbeats }) => {
          try {
            const cleaned: HeartbeatIn[] = heartbeats.map((h) => ({
              ...h,
              lift_or_trail: h.lift_or_trail || null,
              difficulty: h.difficulty || null,
              place: h.place || null,
            }));
            const result = await stub(env, group_token).postHeartbeat(member_token, cleaned);
            return toolText(result);
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "group_map",
        {
          description: "Return the latest position of each member in the group (for the live map).",
          inputSchema: { group_token: z.string(), member_token: z.string() },
        },
        async ({ group_token, member_token }) => {
          try {
            return toolText(await stub(env, group_token).groupMap(member_token));
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "group_stats",
        {
          description: "Return per-member descent, distance, top speed, run count, and time in run/lift/lodge from posted heartbeats.",
          inputSchema: { group_token: z.string(), member_token: z.string() },
        },
        async ({ group_token, member_token }) => {
          try {
            return toolText(await stub(env, group_token).groupStats(member_token));
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "runs_not_hit",
        {
          description:
            "List Winter Park downhill trails from the bundled OpenStreetMap extract that no group member has posted a run heartbeat on. Not affiliated with Winter Park Resort.",
          inputSchema: { group_token: z.string(), member_token: z.string() },
        },
        async ({ group_token, member_token }) => {
          try {
            return toolText(await stub(env, group_token).runsNotHit(member_token));
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "suggest_new_route",
        {
          description: "Suggest a nearby Winter Park trail the group has not hit, plus a lift that finishes close to it.",
          inputSchema: { group_token: z.string(), member_token: z.string() },
        },
        async ({ group_token, member_token }) => {
          try {
            return toolText(await stub(env, group_token).suggestNewRoute(member_token));
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "leave_group",
        {
          description:
            "Leave a SkiHerd group as the authenticated member. Removes that member and their heartbeats. If they were the last member, the group is deleted immediately.",
          inputSchema: { group_token: z.string(), member_token: z.string() },
        },
        async ({ group_token, member_token }) => {
          try {
            return toolText(await stub(env, group_token).leave(member_token));
          } catch (err) {
            return toolError(err);
          }
        },
      );

      server.registerTool(
        "delete_group",
        {
          description:
            "Delete a SkiHerd group now, wiping all of its storage. Any current member can do this. The response and the gone event record who deleted the group.",
          inputSchema: { group_token: z.string(), member_token: z.string() },
        },
        async ({ group_token, member_token }) => {
          try {
            return toolText(await stub(env, group_token).deleteGroup(member_token));
          } catch (err) {
            return toolError(err);
          }
        },
      );

      return server;
    },
    { route: "/mcp" },
  );
  return handler(request, env, ctx);
}
