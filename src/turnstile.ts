/** Cloudflare Turnstile on the HTTP landing page only. MCP is not challenged. */

export type Siteverify = (token: string, ip: string, secret: string) => Promise<{ success: boolean }>;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITE_KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;

declare global {
  interface Env {
    /** Worker secret. Never a wrangler var. Absent means the check is skipped. */
    TURNSTILE_SECRET?: string;
    /** Public site key. Optional var, served to the landing page only. */
    TURNSTILE_SITE_KEY?: string;
  }
}

export function turnstileConfigured(secret: string | undefined): boolean {
  return typeof secret === "string" && secret.length > 0;
}

export async function defaultSiteverify(token: string, ip: string, secret: string): Promise<{ success: boolean }> {
  const res = await fetch(SITEVERIFY_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret, response: token, remoteip: ip }),
  });
  if (!res.ok) throw new Error("turnstile unreachable");
  const data = (await res.json()) as { success?: unknown };
  return { success: data.success === true };
}

export type TurnstileVerdict = "skip" | "ok" | "fail";

/**
 * Missing secret skips the check. A configured secret fails closed on a missing
 * token, a rejected token, or a verifier throw. The caller maps fail to one
 * generic 403 and must not echo provider error codes.
 */
export async function verifyTurnstile(
  token: string | undefined,
  ip: string,
  secret: string | undefined,
  verifier: Siteverify = defaultSiteverify,
): Promise<TurnstileVerdict> {
  if (!turnstileConfigured(secret)) return "skip";
  if (token === undefined || token === "") return "fail";
  try {
    const result = await verifier(token, ip, secret as string);
    return result.success === true ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

/** Insert the widget only when a public site key is configured. Other pages stay unchanged. */
export function landingDocument(html: string, siteKey: string | undefined): string {
  if (siteKey === undefined || !SITE_KEY_RE.test(siteKey)) return html;
  const widget = `<div class="cf-turnstile" data-sitekey="${siteKey}"></div>`;
  const script = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
  const withWidget = html.includes('id="create"')
    ? html.replace('<form id="create"', `${widget}\n      <form id="create"`)
    : html;
  if (withWidget.includes("</body>")) return withWidget.replace("</body>", `${script}\n</body>`);
  return `${withWidget}${script}`;
}
