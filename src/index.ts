import { GroupFullError, GroupGoneError, GroupNotFoundError, SkiGroup, UnauthorizedError, type HeartbeatIn } from "./group";
import { bearer, errorResponse, json, publicBase, securityHeaders } from "./errors";
import { runHealthcheck } from "./health";
import { handleMcp } from "./mcp";
import { clientIp, hashIp, rateLimit } from "./rate-limit";
import { randomToken } from "./tokens";

export { SkiGroup };

function stub(env: Env, groupToken: string) {
  return env.GROUP.get(env.GROUP.idFromName(groupToken));
}

async function limited(request: Request, key: string, limit: number, windowMs: number): Promise<Response | null> {
  const ip = await hashIp(clientIp(request));
  const rl = await rateLimit(caches.default, `${key}:${ip}`, limit, windowMs);
  if (rl.ok) return null;
  return json({ error: "rate limited" }, 429, { "retry-after": String(rl.retryAfterSec) });
}

function withSecurity(res: Response): Response {
  const out = new Response(res.body, res);
  const sec = securityHeaders();
  for (const [k, v] of sec) {
    if (!out.headers.has(k)) out.headers.set(k, v);
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/mcp" || path.startsWith("/mcp/")) {
        const res = await handleMcp(request, env, ctx);
        return withSecurity(res);
      }

      if (path === "/health") {
        const report = await runHealthcheck(env, request);
        return withSecurity(json(report, report.ok ? 200 : 503));
      }

      if (path === "/api/groups" && request.method === "POST") {
        const blocked = await limited(request, "create", Number(env.CREATE_GROUP_PER_IP_PER_HOUR ?? 5), 60 * 60 * 1000);
        if (blocked) return withSecurity(blocked);
        const body = (await request.json().catch(() => ({}))) as { host_name?: string };
        const hostName = (body.host_name ?? "Host").slice(0, 40);
        const groupToken = randomToken(32);
        const created = await stub(env, groupToken).create(hostName);
        const base = publicBase(request, env);
        return withSecurity(
          json({
            ...created,
            host_url: `${base}/g/${created.group_token}`,
            mcp_url: `${base}/mcp`,
          }, 201),
        );
      }

      const api = path.match(/^\/api\/groups\/([^/]+)(?:\/([^/]+))?$/);
      if (api) {
        const groupToken = decodeURIComponent(api[1]);
        const action = api[2] ?? "";
        const group = stub(env, groupToken);

        if (action === "invites" && request.method === "POST") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          const body = (await request.json().catch(() => ({}))) as { ttl_ms?: number; max_uses?: number };
          const inv = await group.createInvite(token, body);
          const base = publicBase(request, env);
          return withSecurity(
            json({
              ...inv,
              invite_url: `${base}/g/${groupToken}?invite=${inv.invite_token}`,
            }, 201),
          );
        }

        if (action === "join" && request.method === "POST") {
          const blocked = await limited(request, "join", 20, 60 * 60 * 1000);
          if (blocked) return withSecurity(blocked);
          const body = (await request.json().catch(() => ({}))) as { invite_token?: string; display_name?: string };
          if (!body.invite_token) return withSecurity(json({ error: "invite_token required" }, 400));
          const joined = await group.join(body.invite_token, body.display_name ?? "Skier");
          const base = publicBase(request, env);
          return withSecurity(json({ ...joined, group_token: groupToken, host_url: `${base}/g/${groupToken}` }, 201));
        }

        if (action === "heartbeats" && request.method === "POST") {
          const blocked = await limited(request, "hb", 120, 60 * 60 * 1000);
          if (blocked) return withSecurity(blocked);
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          const body = (await request.json().catch(() => ({}))) as { heartbeats?: HeartbeatIn[] } & HeartbeatIn;
          const points: HeartbeatIn[] = Array.isArray(body.heartbeats)
            ? body.heartbeats
            : body.lat != null
              ? [body]
              : [];
          const cleaned = points.map((p) => ({
            ...p,
            lift_or_trail: p.lift_or_trail || null,
            difficulty: p.difficulty || null,
            place: p.place || null,
          }));
          return withSecurity(json(await group.postHeartbeat(token, cleaned)));
        }

        if (action === "map" && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(await group.groupMap(token)));
        }

        if (action === "stats" && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(await group.groupStats(token)));
        }

        if (action === "runs-not-hit" && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(await group.runsNotHit(token)));
        }

        if (action === "suggest" && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(await group.suggestNewRoute(token)));
        }

        if (action === "leave" && (request.method === "POST" || request.method === "DELETE")) {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(await group.leave(token)));
        }

        if (!action && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(await group.info(token)));
        }

        if (!action && request.method === "DELETE") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(await group.deleteGroup(token)));
        }

        return withSecurity(json({ error: "not found" }, 404));
      }

      const ws = path.match(/^\/g\/([^/]+)\/ws$/);
      if (ws && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const groupToken = decodeURIComponent(ws[1]);
        const token = url.searchParams.get("member_token") ?? bearer(request);
        if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
        return stub(env, groupToken).sessionWebSocket(request, token);
      }

      if (path.startsWith("/g/")) {
        const page = await env.ASSETS.fetch(new URL("/group.html", request.url));
        return withSecurity(new Response(page.body, { status: page.status, headers: page.headers }));
      }

      const asset = await env.ASSETS.fetch(request);
      return withSecurity(asset);
    } catch (err) {
      // RPC may flatten custom errors; recover by name or message.
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : "";
      if (name === "GroupGoneError" || message === "group expired" || message === "group deleted") {
        return withSecurity(errorResponse(new GroupGoneError(message || "group expired")));
      }
      if (name === "GroupNotFoundError" || message === "group not found") return withSecurity(errorResponse(new GroupNotFoundError()));
      if (/no such table/i.test(message)) return withSecurity(errorResponse(new GroupGoneError("group deleted")));
      if (name === "UnauthorizedError" || message === "unauthorized" || message.startsWith("invite") || message === "invalid invite" || message.includes("only the creator")) {
        return withSecurity(errorResponse(new UnauthorizedError(message || "unauthorized")));
      }
      if (name === "GroupFullError" || message.includes("group is full")) return withSecurity(errorResponse(new GroupFullError()));
      return withSecurity(errorResponse(err));
    }
  },
} satisfies ExportedHandler<Env>;
