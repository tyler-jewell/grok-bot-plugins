import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { runHealthcheck } from "../src/health";
import { landingDocument } from "../src/turnstile";

const SECRET = "configured-for-test";
const SITE_KEY = "site-key-for-test";
const ctx = {} as ExecutionContext;

function withSecret(secret: string | undefined, siteKey?: string): Env {
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === "TURNSTILE_SECRET") return secret;
      if (prop === "TURNSTILE_SITE_KEY") return siteKey;
      return Reflect.get(target, prop, receiver);
    },
  }) as Env;
}

function post(ip: string, token?: string): Request {
  const body = token === undefined
    ? { host_name: "Turnstile" }
    : { host_name: "Turnstile", cf_turnstile_token: token };
  return new Request("https://skiherd.jewell-labs.com/api/groups", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

describe("turnstile on HTTP group creation", () => {
  it("creates a group with no token when the secret is not configured", async () => {
    let verified = false;
    const res = await handleRequest(post("203.0.113.43"), env, ctx, {
      verifier: async () => {
        verified = true;
        return { success: false };
      },
    });
    expect(verified).toBe(false);
    expect(res.status).toBe(201);
    const body = await res.json<{ group_token: string }>();
    expect(body.group_token).toEqual(expect.any(String));
  });

  it("rejects a missing token, a bad token, and a verifier error without creating a group", async () => {
    const cases: Array<{ ip: string; token?: string; verifier: () => Promise<{ success: boolean }> }> = [
      { ip: "203.0.113.44", verifier: async () => { throw new Error("verifier should not run"); } },
      { ip: "203.0.113.45", token: "bad-token", verifier: async () => ({ success: false }) },
      { ip: "203.0.113.46", token: "error-token", verifier: async () => { throw new Error("siteverify down"); } },
    ];
    for (const row of cases) {
      let created = false;
      const res = await handleRequest(post(row.ip, row.token), withSecret(SECRET), ctx, {
        verifier: row.verifier,
        createGroup: async () => {
          created = true;
          throw new Error("create must not run");
        },
      });
      expect(created, row.ip).toBe(false);
      expect(res.status, row.ip).toBe(403);
      expect(await res.json()).toEqual({ error: "verification failed" });
    }
  });

  it("creates a group when the injected verifier accepts the token", async () => {
    const res = await handleRequest(post("203.0.113.47", "good-token"), withSecret(SECRET), ctx, {
      verifier: async (token, ip) => {
        expect(token).toBe("good-token");
        expect(ip).toBe("203.0.113.47");
        return { success: true };
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ group_token: string; member_token: string }>();
    const map = await handleRequest(
      new Request(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}/map`, {
        headers: { authorization: `Bearer ${body.member_token}` },
      }),
      env,
      ctx,
    );
    expect(map.status).toBe(200);
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET);
  });
});

describe("turnstile health and landing page", () => {
  it("reports turnstile disabled, and enabled when the secret is set, without failing health", async () => {
    const live = await SELF.fetch("https://skiherd.jewell-labs.com/health");
    expect(live.status).toBe(200);
    const report = await live.json<{ ok: boolean; components: { turnstile: { ok: boolean; detail: string } } }>();
    expect(report.ok).toBe(true);
    expect(report.components.turnstile.ok).toBe(true);
    expect(report.components.turnstile.detail).toContain("turnstile: disabled");
    expect(report.components.turnstile.detail).toContain("MCP create_group is not challenged");

    const enabled = await runHealthcheck(withSecret(SECRET), new Request("https://skiherd.jewell-labs.com/health"), {
      probe: async () => ({ storage_write: true, storage_read: true, alarm_scheduled: true }),
      mapPage: async () => ({ ok: true, detail: "group map HTML 200" }),
      rateLimiter: async () => ({ ok: true, detail: "limiter reachable" }),
      trails: () => ({ trailCount: 1, liftCount: 1 }),
    });
    expect(enabled.ok).toBe(true);
    expect(enabled.components.turnstile.detail).toContain("turnstile: enabled on the HTTP landing page");
    expect(enabled.components.turnstile.detail).toContain("MCP create_group is not challenged");
  });

  it("allows the Turnstile origins on the landing page only", async () => {
    const home = await SELF.fetch("https://skiherd.jewell-labs.com/");
    const homeCsp = home.headers.get("content-security-policy") ?? "";
    expect(homeCsp).toContain("script-src 'self' https://cdn.jsdelivr.net https://challenges.cloudflare.com");
    expect(homeCsp).toContain("frame-src https://challenges.cloudflare.com");
    expect(await home.text()).not.toContain("challenges.cloudflare.com");

    for (const path of ["/g/x", "/privacy.html", "/terms.html"]) {
      const res = await SELF.fetch(`https://skiherd.jewell-labs.com${path}`);
      expect(res.headers.get("content-security-policy") ?? "", path).not.toContain("challenges.cloudflare.com");
    }
    const privacy = await (await SELF.fetch("https://skiherd.jewell-labs.com/privacy.html")).text();
    expect(privacy).toContain("MCP calls, including create_group, do not use Turnstile");
  });

  it("writes the public site key into the landing page and never the secret", async () => {
    const res = await handleRequest(
      new Request("https://skiherd.jewell-labs.com/"),
      withSecret(SECRET, SITE_KEY),
      ctx,
    );
    const html = await res.text();
    expect(html).toContain(`data-sitekey="${SITE_KEY}"`);
    expect(html).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(html).not.toContain(SECRET);
    expect(landingDocument("<html><body><form id=\"create\"></form></body></html>", "bad key")).not.toContain("data-sitekey");
  });
});
