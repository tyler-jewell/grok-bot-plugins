import { GroupFullError, GroupGoneError, GroupNotFoundError, UnauthorizedError } from "./group";

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof GroupGoneError) return json({ error: err.message, code: "gone" }, 410);
  if (err instanceof GroupNotFoundError) return json({ error: err.message, code: "not_found" }, 404);
  if (err instanceof UnauthorizedError) return json({ error: err.message, code: "unauthorized" }, 401);
  if (err instanceof GroupFullError) return json({ error: err.message, code: "full" }, 409);
  const message = err instanceof Error ? err.message : "internal error";
  if (message === "group already exists") return json({ error: message, code: "conflict" }, 409);
  if (message === "batch too large") return json({ error: message, code: "batch_too_large" }, 413);
  if (/no such table/i.test(message)) return json({ error: "group deleted", code: "gone" }, 410);
  return json({ error: "internal error", code: "error" }, 500);
}

export function bearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (h && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  const q = new URL(request.url).searchParams.get("member_token");
  return q;
}

export function securityHeaders(): Headers {
  const h = new Headers();
  h.set("referrer-policy", "no-referrer");
  h.set("x-content-type-options", "nosniff");
  h.set("x-frame-options", "DENY");
  h.set("permissions-policy", "geolocation=(self), camera=(), microphone=()");
  h.set(
    "content-security-policy",
    [
      "default-src 'self'",
      "script-src 'self' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "img-src 'self' data: blob: https://tiles.openfreemap.org https://*.openfreemap.org",
      "connect-src 'self' https://tiles.openfreemap.org https://*.openfreemap.org",
      "font-src 'self' data: https://tiles.openfreemap.org https://*.openfreemap.org",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join("; "),
  );
  return h;
}

export function publicBase(request: Request, env: Env): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
