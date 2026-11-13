import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import sim from "../data/sim-heartbeats-5min.json";
import { SkiGroup } from "../src/group";

const summary = {
  tyler: { descent_ft: 7720, runs: 8, top_speed_mph: 12.7, distance_km: 21.48, points: 73, run_names: ["Sober Englishman", "Allan Phipps", "March Hare", "Cranmer", "Jack Kendrick", "Village Way", "Moose Wallow", "Village Way"] },
  alex: { descent_ft: 10138, runs: 13, top_speed_mph: 12.8, distance_km: 31.49, points: 73 },
  sam: { descent_ft: 7736, runs: 8, top_speed_mph: 12.8, distance_km: 21.46, points: 73 },
};

function stub(name: string) {
  return env.GROUP.get(env.GROUP.idFromName(name));
}


describe("SkiGroup", () => {
  it("creates a group, caps invites at 10, and rejects a bad token", async () => {
    const group = stub("test-cap-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    expect(host.member_token).toMatch(/^[0-9a-f]{64}$/);
    const info = await group.info();
    expect(info.member_count).toBe(1);
    expect(info.max_members).toBe(10);

    const invite = await group.createInvite(host.member_token, { max_uses: 9, ttl_ms: 3_600_000 });
    for (let i = 0; i < 9; i++) {
      await group.join(invite.invite_token, `Skier ${i + 2}`);
    }
    await runInDurableObject(group, async (inst: SkiGroup) => {
      await expect(inst.join(invite.invite_token, "Eleventh")).rejects.toThrow(/full|already used/i);
      await expect(inst.groupMap("not-a-token")).rejects.toThrow(/unauthorized/i);
    });
    const full = await group.info();
    expect(full.member_count).toBe(10);
  });

  it("deletes all storage when the 24h alarm fires", async () => {
    const group = stub("test-alarm-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    await group.postHeartbeat(host.member_token, [
      { ts: new Date().toISOString(), lat: 39.88, lon: -105.76, activity: "run", lift_or_trail: "Cranmer" },
    ]);
    const before = await runInDurableObject(group, async (_inst, state) => {
      const n = state.storage.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM heartbeats").one().c;
      const alarm = await state.storage.getAlarm();
      return { n, alarm };
    });
    expect(before.n).toBe(1);
    expect(before.alarm).toBeTypeOf("number");

    const ran = await runDurableObjectAlarm(group);
    expect(ran).toBe(true);

    const leftover = await runInDurableObject(group, async (_inst, state) => {
      // deleteAll wipes the SQLite schema. The constructor does not re-run
      // on this still-resident instance.
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray();
      const alarm = await state.storage.getAlarm();
      return { tables, alarm };
    });
    expect(leftover.tables).toEqual([]);
    expect(leftover.alarm).toBeNull();
    await evictDurableObject(group);
    await runInDurableObject(group, async (inst: SkiGroup) => {
      await expect(inst.info()).rejects.toThrow(/not found/i);
    });
  });

  it("replays the simulated Winter Park day and matches 5-minute stats", async () => {
    const group = stub("test-sim-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    const byUser = new Map<string, typeof sim.heartbeats>();
    for (const hb of sim.heartbeats) {
      const list = byUser.get(hb.user_id) ?? [];
      list.push(hb);
      byUser.set(hb.user_id, list);
    }
    expect(sim.heartbeats).toHaveLength(219);

    const tokens = new Map<string, string>([["tyler", host.member_token]]);
    const invite = await group.createInvite(host.member_token, { max_uses: 2 });
    tokens.set("alex", (await group.join(invite.invite_token, "Alex")).member_token);
    tokens.set("sam", (await group.join(invite.invite_token, "Sam")).member_token);

    for (const [user, token] of tokens) {
      const points = (byUser.get(user) ?? []).map((h) => ({
        ts: h.ts,
        lat: h.lat,
        lon: h.lon,
        alt_m: h.alt_m,
        accuracy_m: h.accuracy_m,
        speed_mps: h.speed_mps,
        heading_deg: h.heading_deg,
        battery_pct: h.battery_pct,
        activity: h.activity,
        place: h.place || null,
        lift_or_trail: h.lift_or_trail || null,
        difficulty: h.difficulty || null,
      }));
      const res = await group.postHeartbeat(token, points);
      expect(res.accepted).toBe(points.length);
    }

    const stats = await group.groupStats(host.member_token);
    const byName = Object.fromEntries(stats.members.map((m) => [m.name.toLowerCase(), m]));
    for (const [key, expected] of Object.entries(summary)) {
      const got = byName[key === "tyler" ? "tyler" : key];
      expect(got.points).toBe(expected.points);
      expect(got.runs).toBe(expected.runs);
      expect(got.descent_ft).toBeCloseTo(expected.descent_ft, 0);
      expect(got.top_speed_mph).toBeCloseTo(expected.top_speed_mph, 1);
      expect(got.distance_km).toBeCloseTo(expected.distance_km, 1);
    }
    expect(byName.tyler.run_names).toEqual(summary.tyler.run_names);

    const notHit = await group.runsNotHit(host.member_token);
    expect(notHit.visited).toEqual(expect.arrayContaining(["Sober Englishman", "Allan Phipps", "Whistlestop", "Bluebell"]));
    expect(notHit.not_hit.find((t) => t.name === "Sober Englishman")).toBeUndefined();
    expect(notHit.not_hit.length).toBeGreaterThan(10);

    const suggestion = await group.suggestNewRoute(host.member_token);
    expect(suggestion).toHaveProperty("trail");
    if ("trail" in suggestion) {
      expect(notHit.visited).not.toContain(suggestion.trail);
    }

    const map = await group.groupMap(host.member_token);
    expect(map.members).toHaveLength(3);
    for (const m of map.members) {
      expect(m.lat).toBeTypeOf("number");
      expect(m.lon).toBeTypeOf("number");
    }
  });
});

describe("HTTP worker", () => {
  it("creates a group over HTTP and serves the map page", async () => {
    const res = await SELF.fetch("https://skiherd.jewell-labs.com/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
      body: JSON.stringify({ host_name: "Tyler" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ group_token: string; member_token: string; host_url: string }>();
    const map = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}/map`, {
      headers: { authorization: `Bearer ${body.member_token}` },
    });
    expect(map.status).toBe(200);
    const page = await SELF.fetch(`https://skiherd.jewell-labs.com/g/${body.group_token}?member_token=${body.member_token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Group ski map");
    expect(html).toContain("OpenStreetMap");
  });

  it("returns 401 without a member token and 429 when create is flooded", async () => {
    const denied = await SELF.fetch("https://skiherd.jewell-labs.com/api/groups/does-not-exist/map");
    expect(denied.status).toBe(401);
    const ip = "203.0.113.99";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await SELF.fetch("https://skiherd.jewell-labs.com/api/groups", {
        method: "POST",
        headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
        body: JSON.stringify({ host_name: "Flood" }),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(5);
    expect(statuses).toContain(429);
  });
});
