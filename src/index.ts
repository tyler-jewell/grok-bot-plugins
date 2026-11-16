import { GroupFullError, GroupGoneError, GroupNotFoundError, SkiGroup, UnauthorizedError, unwrapDomain, type HeartbeatIn } from "./group";
import { bearer, errorResponse, json, publicBase, queryHasMemberToken, queryTokenRejected, securityHeaders } from "./errors";
import { runHealthcheck } from "./health";
import { handleMcp } from "./mcp";
import { checkLimit, clientIp } from "./rate-limit";
import { randomToken } from "./tokens";
import { landingDocument, verifyTurnstile, type Siteverify } from "./turnstile";

export { SkiGroup };

function stub(env: Env, groupToken: string) {
  return env.GROUP.get(env.GROUP.idFromName(groupToken));
}

async function limited(request: Request, env: Env, name: Parameters<typeof checkLimit>[2]): Promise<Response | null> {
  const rl = await checkLimit(request, env, name);
  if (rl.ok) return null;
  return json({ error: "rate limited" }, 429, { "retry-after": String(rl.retryAfterSec) });
}

function withSecurity(res: Response, opts?: { turnstile?: boolean }): Response {
  const out = new Response(res.body, res);
  const sec = securityHeaders(opts);
  for (const [k, v] of sec) {
    if (!out.headers.has(k)) out.headers.set(k, v);
  }
  return out;
}

export type RequestDeps = {
  /** Injected in tests. Production uses the Cloudflare siteverify endpoint. */
  verifier?: Siteverify;
  /** Injected in tests to prove a rejected token never calls create. */
  createGroup?: (env: Env, groupToken: string, hostName: string) => Promise<Awaited<ReturnType<SkiGroup["create"]>>>;
};

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, deps: RequestDeps = {}): Promise<Response> {
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
        const blocked = await limited(request, env, "create");
        if (blocked) return withSecurity(blocked);
        const body = (await request.json().catch(() => ({}))) as { host_name?: string; cf_turnstile_token?: string };
        const hostName = (body.host_name ?? "Host").slice(0, 40);
        const verdict = await verifyTurnstile(body.cf_turnstile_token, clientIp(request), env.TURNSTILE_SECRET, deps.verifier);
        if (verdict === "fail") return withSecurity(json({ error: "verification failed" }, 403));
        const groupToken = randomToken(32);
        const created = deps.createGroup
          ? await deps.createGroup(env, groupToken, hostName)
          : unwrapDomain(await stub(env, groupToken).create(hostName));
        const base = publicBase(request, env);
        return withSecurity(
          json({
            ...created,
            host_url: `${base}/g/${created.group_token}`,
            member_map_url: `${base}/g/${created.group_token}#t=${created.member_token}`,
            mcp_url: `${base}/mcp`,
          }, 201),
        );
      }

      const api = path.match(/^\/api\/groups\/([^/]+)(?:\/([^/]+))?$/);
      if (api) {
        if (queryHasMemberToken(request)) return withSecurity(queryTokenRejected());
        const groupToken = decodeURIComponent(api[1]);
        const action = api[2] ?? "";
        const group = stub(env, groupToken);

        if (action === "invites" && request.method === "POST") {
          const blocked = await limited(request, env, "invite");
          if (blocked) return withSecurity(blocked);
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          const body = (await request.json().catch(() => ({}))) as { ttl_ms?: number; max_uses?: number };
          const inv = unwrapDomain(await group.createInvite(token, body));
          const base = publicBase(request, env);
          return withSecurity(
            json({
              ...inv,
              invite_url: `${base}/g/${groupToken}?invite=${inv.invite_token}`,
            }, 201),
          );
        }

        if (action === "join" && request.method === "POST") {
          const blocked = await limited(request, env, "join");
          if (blocked) return withSecurity(blocked);
          const body = (await request.json().catch(() => ({}))) as { invite_token?: string; display_name?: string };
          if (!body.invite_token) return withSecurity(json({ error: "invite_token required" }, 400));
          const joined = unwrapDomain(await group.join(body.invite_token, body.display_name ?? "Skier"));
          const base = publicBase(request, env);
          return withSecurity(json({ ...joined, group_token: groupToken, host_url: `${base}/g/${groupToken}`, member_map_url: `${base}/g/${groupToken}#t=${joined.member_token}` }, 201));
        }

        if (action === "heartbeats" && request.method === "POST") {
          const blocked = await limited(request, env, "hb");
          if (blocked) return withSecurity(blocked);
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          const raw: unknown = await request.json().catch(() => ({}));
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
            return withSecurity(json({ error: "body must be a JSON object" }, 400));
          }
          const body = raw as { heartbeats?: unknown } & HeartbeatIn;
          if ("heartbeats" in body && !Array.isArray(body.heartbeats)) {
            return withSecurity(json({ error: "heartbeats must be an array" }, 400));
          }
          const points: HeartbeatIn[] = Array.isArray(body.heartbeats)
            ? (body.heartbeats as HeartbeatIn[])
            : body.lat != null
              ? [body]
              : [];
          if (points.some((p) => p === null || typeof p !== "object" || Array.isArray(p))) {
            return withSecurity(json({ error: "heartbeats must be objects" }, 400));
          }
          const cleaned = points.map((p) => ({
            ...p,
            lift_or_trail: p.lift_or_trail || null,
            difficulty: p.difficulty || null,
            place: p.place || null,
          }));
          return withSecurity(json(unwrapDomain(await group.postHeartbeat(token, cleaned))));
        }

        if (action === "map" && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(unwrapDomain(await group.groupMap(token))));
        }

        if (action === "stats" && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(unwrapDomain(await group.groupStats(token))));
        }

        if (action === "runs-not-hit" && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(unwrapDomain(await group.runsNotHit(token))));
        }

        if (action === "suggest" && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(unwrapDomain(await group.suggestNewRoute(token))));
        }

        if (action === "leave" && (request.method === "POST" || request.method === "DELETE")) {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(unwrapDomain(await group.leave(token))));
        }

        if (!action && request.method === "GET") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(unwrapDomain(await group.info(token))));
        }

        if (!action && request.method === "DELETE") {
          const token = bearer(request);
          if (!token) return withSecurity(json({ error: "unauthorized" }, 401));
          return withSecurity(json(unwrapDomain(await group.deleteGroup(token))));
        }

        return withSecurity(json({ error: "not found" }, 404));
      }

      const ws = path.match(/^\/g\/([^/]+)\/ws$/);
      if (ws) {
        if (queryHasMemberToken(request)) return withSecurity(queryTokenRejected());
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return withSecurity(json({ error: "WebSocket upgrade required", code: "upgrade_required" }, 426));
        }
        const groupToken = decodeURIComponent(ws[1]);
        return stub(env, groupToken).fetch(request);
      }

      if (path.startsWith("/g/")) {
        const page = await env.ASSETS.fetch(new URL("/group.html", request.url));
        const headers = new Headers(page.headers);
        headers.set("cache-control", "no-store");
        return withSecurity(new Response(page.body, { status: page.status, headers }));
      }

      if ((path === "/" || path === "/index.html") && request.method === "GET") {
        const asset = await env.ASSETS.fetch(request);
        const html = landingDocument(await asset.text(), env.TURNSTILE_SITE_KEY);
        const headers = new Headers(asset.headers);
        headers.delete("content-length");
        return withSecurity(new Response(html, { status: asset.status, headers }), { turnstile: true });
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
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
