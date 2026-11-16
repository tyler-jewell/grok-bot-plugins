import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COUNTER_RETAIN_DAYS, type DailyCounters } from "../src/counters";

const BASE = "https://skiherd.jewell-labs.com";
const DAY_MS = 86_400_000;
const ALLOWED = new Set([
  "created",
  "deleted",
  "expired",
  "rate_limit:create",
  "rate_limit:join",
  "rate_limit:invite",
  "rate_limit:heartbeat",
  "error:4xx",
  "error:5xx",
]);

type Snapshot = { days: Array<{ day: string; counters: Record<string, number> }> };

function totals(body: Snapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const day of body.days) {
    for (const [name, value] of Object.entries(day.counters)) {
      out[name] = (out[name] ?? 0) + value;
    }
  }
  return out;
}

async function readCounters(): Promise<Snapshot> {
  const res = await SELF.fetch(`${BASE}/counters`);
  expect(res.status).toBe(200);
  return res.json<Snapshot>();
}

describe("daily counters", () => {
  it("counts create, member delete, alarm expiry, a rate-limit rejection, and an HTTP error on the request path", async () => {
    const before = totals(await readCounters());
    const ip = "203.0.113.214";
    const host = "ZZCounterHostZZ";

    const first = await SELF.fetch(`${BASE}/api/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ host_name: host }),
    });
    expect(first.status).toBe(201);
    const created = await first.json<{ group_token: string; member_token: string }>();

    const deleted = await SELF.fetch(`${BASE}/api/groups/${created.group_token}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${created.member_token}`, "CF-Connecting-IP": ip },
    });
    expect(deleted.status).toBe(200);

    const second = await SELF.fetch(`${BASE}/api/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ host_name: host }),
    });
    expect(second.status).toBe(201);
    const expiring = await second.json<{ group_token: string }>();
    const group = env.GROUP.get(env.GROUP.idFromName(expiring.group_token));
    expect(await runDurableObjectAlarm(group)).toBe(true);

    // Five creates per IP per hour are allowed. Two already succeeded.
    for (let i = 0; i < 3; i++) {
      const ok = await SELF.fetch(`${BASE}/api/groups`, {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ host_name: host }),
      });
      expect(ok.status, `create ${i + 3}`).toBe(201);
    }
    const limited = await SELF.fetch(`${BASE}/api/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ host_name: host }),
    });
    expect(limited.status).toBe(429);

    const missing = await SELF.fetch(`${BASE}/api/groups/${created.group_token}/no-such-action`, {
      headers: { "CF-Connecting-IP": ip },
    });
    expect(missing.status).toBe(404);

    const body = await readCounters();
    const after = totals(body);
    const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
    expect(delta("created")).toBe(5);
    expect(delta("deleted")).toBe(1);
    expect(delta("expired")).toBe(1);
    expect(delta("rate_limit:create")).toBe(1);
    expect(delta("error:4xx")).toBe(2);

    const text = JSON.stringify(body);
    expect(text).not.toContain(created.group_token);
    expect(text).not.toContain(created.member_token);
    expect(text).not.toContain(expiring.group_token);
    expect(text).not.toContain(host);
    expect(text).not.toContain(ip);
    expect(Object.keys(body).sort()).toEqual(["days"]);
    for (const day of body.days) {
      expect(day.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.keys(day).sort()).toEqual(["counters", "day"]);
      for (const [name, value] of Object.entries(day.counters)) {
        expect(ALLOWED.has(name), name).toBe(true);
        expect(Number.isInteger(value), name).toBe(true);
      }
    }
  });

  it("stores only a day, a counter name, and an integer, and the alarm drops days older than 35", async () => {
    const stub = env.COUNTERS.get(env.COUNTERS.idFromName(`probe-${crypto.randomUUID()}`));
    const now = Date.now();
    const secret = `tok_${crypto.randomUUID()}`;
    const keptDay = new Date(now - COUNTER_RETAIN_DAYS * DAY_MS).toISOString().slice(0, 10);
    const droppedDay = new Date(now - (COUNTER_RETAIN_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);

    const seeded = await runInDurableObject(stub, async (inst: DailyCounters, state) => {
      expect(await inst.add("created", now - (COUNTER_RETAIN_DAYS + 1) * DAY_MS)).toEqual({ ok: true });
      expect(await inst.add("deleted", now - COUNTER_RETAIN_DAYS * DAY_MS)).toEqual({ ok: true });
      expect(await inst.add("expired", now)).toEqual({ ok: true });
      expect(await inst.add(secret)).toEqual({ ok: false });
      expect(await inst.add(`rate_limit:${secret}`)).toEqual({ ok: false });
      const raw = state.storage.sql.exec("SELECT * FROM counters").toArray() as Array<Record<string, unknown>>;
      return raw;
    });

    expect(seeded.length).toBeGreaterThan(0);
    for (const row of seeded) {
      expect(Object.keys(row).sort()).toEqual(["day", "name", "value"]);
      expect(ALLOWED.has(String(row.name)), String(row.name)).toBe(true);
      const value = typeof row.value === "bigint" ? Number(row.value) : row.value;
      expect(Number.isInteger(value)).toBe(true);
      expect(JSON.stringify(row)).not.toContain(secret);
    }
    expect(seeded.map((row) => row.day)).toContain(droppedDay);
    expect(seeded.map((row) => row.day)).toContain(keptDay);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const kept = await runInDurableObject(stub, async (inst: DailyCounters, state) => {
      const raw = state.storage.sql.exec("SELECT * FROM counters ORDER BY day, name").toArray() as Array<Record<string, unknown>>;
      const viaMethod = await inst.rows();
      return { raw, viaMethod };
    });
    const days = kept.raw.map((row) => String(row.day));
    expect(days).not.toContain(droppedDay);
    expect(days).toContain(keptDay);
    expect(kept.viaMethod.map((row) => row.day)).not.toContain(droppedDay);
    expect(kept.viaMethod.every((row) => ALLOWED.has(row.name) && Number.isInteger(row.value))).toBe(true);
    expect(JSON.stringify(kept.raw)).not.toContain(secret);
  });
});
