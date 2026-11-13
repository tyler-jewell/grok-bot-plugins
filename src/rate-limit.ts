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

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "local";
}

export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
