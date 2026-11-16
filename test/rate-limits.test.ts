import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SkiGroup } from "../src/group";
import { intFromEnv } from "../src/rate-limit";

const BASE = "https://skiherd.jewell-labs.com";
let ipCounter = 0;
/** Unique documentation-range IP per test so Cache API buckets never collide. */
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function http(path: string, ip: string, extra: Record<string, string> = {}, body: unknown = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip, ...extra },
    body: JSON.stringify(body),
  });
}

async function mcpTool(name: string, args: object, ip: string): Promise<{ isError?: boolean; payload: { error?: string; message?: string } }> {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "CF-Connecting-IP": ip },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const dataLine = raw.trim().startsWith("{") ? raw.trim() : raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).pop()!.slice(5);
  const msg = JSON.parse(dataLine) as { result?: { isError?: boolean; content: Array<{ text: string }> } };
  const text = msg.result!.content[0].text;
  let payload: { error?: string; message?: string } = {};
  try {
    payload = JSON.parse(text);
  } catch {
    /* success payloads are JSON too; ignore */
  }
  return { isError: msg.result!.isError, payload };
}

const hbArgs = { group_token: "g", member_token: "m", heartbeats: [{ ts: new Date().toISOString(), lat: 39.88, lon: -105.76 }] };
const joinArgs = { group_token: "g", invite_token: "i", display_name: "A" };
const inviteArgs = { group_token: "g", member_token: "m" };

/** Calls `n` times (all must pass the limiter) then once more (must be rate limited). */
async function mcpEdge(tool: string, args: object, n: number) {
  const ip = freshIp();
  for (let i = 0; i < n; i++) {
    const r = await mcpTool(tool, args, ip);
    expect(r.payload.error, `call ${i + 1} of ${n} must not be rate limited`).not.toBe("rate_limited");
  }
  const over = await mcpTool(tool, args, ip);
  expect(over.isError).toBe(true);
  expect(over.payload.error).toBe("rate_limited");
  expect(over.payload.message).toMatch(/rate limited, retry in \d+s/);
  // another client is unaffected
  const other = await mcpTool(tool, args, freshIp());
  expect(other.payload.error).not.toBe("rate_limited");
}

describe("MCP rate limits (#18)", () => {
  it("post_heartbeat: 120/h per IP passes, 121st is a rate-limited tool error", async () => {
    await mcpEdge("post_heartbeat", hbArgs, 120);
  });
  it("join_group: 20/h per IP passes, 21st is a rate-limited tool error", async () => {
    await mcpEdge("join_group", joinArgs, 20);
  });
  it("create_invite: 20/h per IP passes, 21st is a rate-limited tool error", async () => {
    await mcpEdge("create_invite", inviteArgs, 20);
  });
});

describe("HTTP rate limits (#18)", () => {
  it("heartbeats: 120/h per IP passes, 121st is 429 with retry-after", async () => {
    const ip = freshIp();
    for (let i = 0; i < 120; i++) {
      expect((await http("/api/groups/g/heartbeats", ip)).status, `call ${i + 1}`).not.toBe(429);
    }
    const over = await http("/api/groups/g/heartbeats", ip);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await http("/api/groups/g/heartbeats", freshIp())).status).not.toBe(429);
  });

  it("invites: 20/h per IP passes, 21st is 429 with retry-after", async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      expect((await http("/api/groups/g/invites", ip)).status, `call ${i + 1}`).not.toBe(429);
    }
    const over = await http("/api/groups/g/invites", ip);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("limiter key cannot be bypassed (#18)", () => {
  it("case, whitespace and X-Forwarded-For variation share one bucket when CF-Connecting-IP is set", async () => {
    const variants = ["2001:DB8::7", "2001:db8::7", "  2001:Db8::7  "];
    for (let i = 0; i < 20; i++) {
      const res = await http("/api/groups/g/join", variants[i % 3], { "X-Forwarded-For": `10.0.0.${i}` });
      expect(res.status, `call ${i + 1}`).not.toBe(429);
    }
    const over = await http("/api/groups/g/join", "2001:DB8::7", { "X-Forwarded-For": "10.9.9.9" });
    expect(over.status).toBe(429);
  });

  it("HTTP and MCP draw from the same per-IP bucket", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) await http("/api/groups/g/join", ip);
    for (let i = 0; i < 10; i++) await mcpTool("join_group", joinArgs, ip);
    expect((await http("/api/groups/g/join", ip)).status).toBe(429);
    expect((await mcpTool("join_group", joinArgs, ip)).payload.error).toBe("rate_limited");
  });
});

describe("limit configuration (#18)", () => {
  it("falls back to the default for unset, non-numeric, fractional, zero or negative values", () => {
    for (const bad of [undefined, "", "abc", "NaN", "1.5", "0", "-3"]) {
      expect(intFromEnv({ X: bad }, "X", 7), String(bad)).toBe(7);
    }
    expect(intFromEnv({ X: "1" }, "X", 7)).toBe(1);
    expect(intFromEnv({ X: "250" }, "X", 7)).toBe(250);
  });
});

describe("per-group heartbeat row cap (#18)", () => {
  async function withCap(cap: string, fn: (inst: SkiGroup, token: string, count: () => number) => Promise<void>) {
    const group = env.GROUP.get(env.GROUP.idFromName("cap-" + crypto.randomUUID()));
    const host = await group.create("Tyler");
    await runInDurableObject(group, async (inst: SkiGroup, state) => {
      const e = { ...(inst as unknown as { env: object }).env } as Record<string, unknown>;
      e.MAX_HEARTBEATS_PER_GROUP = cap;
      Object.defineProperty(inst, "env", { value: e });
      const count = () => state.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM heartbeats").one().c;
      await fn(inst, host.member_token, count);
    });
  }
  const pts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ts: new Date(Date.now() - i * 1000).toISOString(), lat: 39.88, lon: -105.76 }));

  it("stores at most the cap: exactly cap accepted, cap+1 dropped, later batches dropped", async () => {
    await withCap("5", async (inst, token, count) => {
      expect(await inst.postHeartbeat(token, pts(3))).toEqual({ accepted: 3 });
      // 2 slots left, batch of 4: boundary just inside (2 stored) and outside (2 dropped)
      expect(await inst.postHeartbeat(token, pts(4))).toEqual({ accepted: 2, dropped_over_cap: 2 });
      expect(count()).toBe(5);
      expect(await inst.postHeartbeat(token, pts(1))).toEqual({ accepted: 0, dropped_over_cap: 1 });
      expect(count()).toBe(5);
    });
  });

  it("invalid points do not consume cap slots", async () => {
    await withCap("2", async (inst, token, count) => {
      const bad = { ts: new Date().toISOString(), lat: 999, lon: 0 };
      expect(await inst.postHeartbeat(token, [bad, bad, ...pts(2)])).toEqual({ accepted: 2 });
      expect(count()).toBe(2);
    });
  });
});
