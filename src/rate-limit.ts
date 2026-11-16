/**
 * Application-level rate limits (no Cloudflare Rate Limiting binding, so
 * `wrangler deploy` cannot provision account resources). Uses the Cache API.
 * Production should also add Turnstile on create_group before going public.
 */

export async function rateLimit(
  cache: Cache,
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const url = new URL("https://skiherd.rate-limit.invalid/" + encodeURIComponent(key));
  const now = Date.now();
  const hit = await cache.match(url);
  let stamps: number[] = [];
  if (hit) {
    try {
      stamps = (await hit.json()) as number[];
    } catch {
      stamps = [];
    }
  }
  stamps = stamps.filter((t) => now - t < windowMs);
  if (stamps.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - stamps[0])) / 1000));
    return { ok: false, retryAfterSec };
  }
  stamps.push(now);
  await cache.put(
    url,
    new Response(JSON.stringify(stamps), {
      headers: { "Cache-Control": `max-age=${Math.ceil(windowMs / 1000)}` },
    }),
  );
  return { ok: true };
}

/**
 * Client address for limiter keys. CF-Connecting-IP is set by Cloudflare's edge
 * (a client-supplied copy is overwritten), so it wins. X-Forwarded-For is only
 * a fallback for non-Cloudflare dev runs and is ignored whenever CF-Connecting-IP
 * is present. Normalised (trim, lowercase) so "2001:DB8::1" and " 2001:db8::1 "
 * share one bucket.
 */
export function clientIp(request: Request): string {
  const raw = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0] ?? "";
  return raw.trim().toLowerCase() || "local";
}

/** Default per-IP limits, per hour. Override with the named Worker var; invalid or < 1 falls back. */
export const LIMITS = {
  create: { env: "CREATE_GROUP_PER_IP_PER_HOUR", default: 5 },
  join: { env: "JOIN_PER_IP_PER_HOUR", default: 20 },
  invite: { env: "INVITE_PER_IP_PER_HOUR", default: 20 },
  hb: { env: "HEARTBEAT_PER_IP_PER_HOUR", default: 120 },
} as const;
export const RATE_WINDOW_MS = 60 * 60 * 1000;

export function intFromEnv(env: unknown, name: string, fallback: number): number {
  const n = Number((env as Record<string, unknown>)[name]);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/**
 * Shared by HTTP and MCP so both entry points draw from the same per-IP bucket
 * (alternating transports cannot double the allowance).
 */
export async function checkLimit(
  request: Request,
  env: unknown,
  name: keyof typeof LIMITS,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const cfg = LIMITS[name];
  const ip = await hashIp(clientIp(request));
  return rateLimit(caches.default, `${name}:${ip}`, intFromEnv(env, cfg.env, cfg.default), RATE_WINDOW_MS);
}

export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
