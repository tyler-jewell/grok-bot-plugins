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
    const info = await group.info(host.member_token);
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
    const full = await group.info(host.member_token);
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
      await expect(inst.info("gone")).rejects.toThrow(/not found|deleted|expired/i);
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

describe("leave and delete", () => {
  it("lets a member leave and lets any current member delete the group", async () => {
    const group = stub("test-delete-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    const invite = await group.createInvite(host.member_token, { max_uses: 1 });
    const guest = await group.join(invite.invite_token, "Alex");
    expect((await group.info(host.member_token)).member_count).toBe(2);

    const left = await group.leave(guest.member_token);
    expect(left).toMatchObject({ left: true, group_deleted: false });
    expect((await group.info(host.member_token)).member_count).toBe(1);

    const deleted = await group.deleteGroup(host.member_token);
    expect(deleted).toMatchObject({ deleted: true });
    expect(deleted.deleted_by).toMatchObject({ name: "Tyler" });
    expect(deleted.deleted_by.member_id).toBeTruthy();
    await evictDurableObject(group);
    await runInDurableObject(group, async (inst: SkiGroup) => {
      await expect(inst.info("gone")).rejects.toThrow(/not found|deleted|expired/i);
    });
  });

  it("deletes the group when the last member leaves", async () => {
    const group = stub("test-last-leave-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    const left = await group.leave(host.member_token);
    expect(left).toMatchObject({ left: true, group_deleted: true });
    expect(left.deleted_by).toMatchObject({ name: "Tyler" });
    await evictDurableObject(group);
    await runInDurableObject(group, async (inst: SkiGroup) => {
      await expect(inst.info("gone")).rejects.toThrow(/not found|deleted|expired/i);
    });
  });

  it("supports leave and delete over HTTP", async () => {
    const created = await SELF.fetch("https://skiherd.jewell-labs.com/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.40" },
      body: JSON.stringify({ host_name: "Tyler" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json<{ group_token: string; member_token: string }>();
    const inviteRes = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.member_token}`, "content-type": "application/json" },
      body: JSON.stringify({ max_uses: 1 }),
    });
    const invite = await inviteRes.json<{ invite_token: string }>();
    const joinedRes = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite_token: invite.invite_token, display_name: "Alex" }),
    });
    const guest = await joinedRes.json<{ member_token: string }>();
    const leave = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}/leave`, {
      method: "POST",
      headers: { authorization: `Bearer ${guest.member_token}` },
    });
    expect(leave.status).toBe(200);
    expect(await leave.json()).toMatchObject({ left: true, group_deleted: false });

    const del = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${body.member_token}` },
    });
    expect(del.status).toBe(200);
    const deleted = await del.json<{ deleted: boolean; deleted_by: { name: string } }>();
    expect(deleted).toMatchObject({ deleted: true, deleted_by: { name: "Tyler" } });
  });
});

describe("post-wipe error shapes and recreate (#7)", () => {
  it("returns a clean gone/not_found error after delete without evicting, and does not resurrect stale state on recreate", async () => {
    const name = "test-wipe-recreate-" + crypto.randomUUID();
    const group = stub(name);
    const host = await group.create("Tyler");
    await group.postHeartbeat(host.member_token, [
      { ts: new Date().toISOString(), lat: 39.88, lon: -105.76, activity: "run", lift_or_trail: "Cranmer" },
    ]);

    const deleted = await group.deleteGroup(host.member_token);
    expect(deleted).toMatchObject({ deleted: true });

    const after = await runInDurableObject(group, async (inst: SkiGroup) => {
      try {
        await inst.groupMap(host.member_token);
        return { threw: false, message: "", name: "" };
      } catch (err) {
        return { threw: true, message: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : "" };
      }
    });
    expect(after.threw).toBe(true);
    expect(after.message).not.toMatch(/no such table|SQLITE/i);
    expect(after.message).toMatch(/deleted|expired|not found/i);
    expect(after.name).toMatch(/GroupGoneError|GroupNotFoundError/);

    const recreated = await group.create("Alex");
    expect(recreated.member_token).not.toBe(host.member_token);
    const map = await group.groupMap(recreated.member_token);
    expect(map.members).toHaveLength(1);
    expect(map.members[0].name).toBe("Alex");
    expect(map.members[0].lat).toBeNull();

    const stale = await runInDurableObject(group, async (inst: SkiGroup) => {
      try {
        await inst.groupMap(host.member_token);
        return { threw: false, message: "" };
      } catch (err) {
        return { threw: true, message: err instanceof Error ? err.message : String(err) };
      }
    });
    expect(stale.threw).toBe(true);
    expect(stale.message).toMatch(/unauthorized/i);

    const alarm = await runInDurableObject(group, async (_inst, state) => state.storage.getAlarm());
    expect(alarm).toBeTypeOf("number");
    expect(alarm).toBeGreaterThan(Date.parse(recreated.created_at));
  });

  it("returns a clean gone error after the 24h alarm without evicting", async () => {
    const group = stub("test-alarm-gone-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    const ran = await runDurableObjectAlarm(group);
    expect(ran).toBe(true);
    const after = await runInDurableObject(group, async (inst: SkiGroup) => {
      try {
        await inst.groupMap(host.member_token);
        return { threw: false, message: "" };
      } catch (err) {
        return { threw: true, message: err instanceof Error ? err.message : String(err) };
      }
    });
    expect(after.threw).toBe(true);
    expect(after.message).not.toMatch(/no such table|SQLITE/i);
    expect(after.message).toMatch(/deleted|expired|not found/i);
  });

  it("returns a clean gone error after the last member leaves, without evicting", async () => {
    const group = stub("test-last-leave-gone-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    const left = await group.leave(host.member_token);
    expect(left).toMatchObject({ left: true, group_deleted: true });
    const after = await runInDurableObject(group, async (inst: SkiGroup) => {
      try {
        await inst.info(host.member_token);
        return { threw: false, message: "" };
      } catch (err) {
        return { threw: true, message: err instanceof Error ? err.message : String(err) };
      }
    });
    expect(after.threw).toBe(true);
    expect(after.message).not.toMatch(/no such table|SQLITE/i);
    expect(after.message).toMatch(/deleted|expired|not found/i);
  });

  it("returns HTTP 410 with code gone after delete, without evicting", async () => {
    const created = await SELF.fetch("https://skiherd.jewell-labs.com/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.50" },
      body: JSON.stringify({ host_name: "Tyler" }),
    });
    const body = await created.json<{ group_token: string; member_token: string }>();
    const del = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${body.member_token}` },
    });
    expect(del.status).toBe(200);
    const map = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}/map`, {
      headers: { authorization: `Bearer ${body.member_token}` },
    });
    expect(map.status).toBe(410);
    const payload = await map.json<{ error: string; code?: string }>();
    expect(payload.code).toBe("gone");
    expect(payload.error).not.toMatch(/no such table|SQLITE/i);
    expect(payload.error).toMatch(/deleted|expired/i);
  });
});

describe("authenticated group info (#8)", () => {
  it("rejects a missing or invalid member token on GET /api/groups/:id", async () => {
    const created = await SELF.fetch("https://skiherd.jewell-labs.com/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.51" },
      body: JSON.stringify({ host_name: "Tyler" }),
    });
    const body = await created.json<{ group_token: string; member_token: string }>();
    const missing = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}`);
    expect(missing.status).toBe(401);
    const bogus = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(bogus.status).toBe(401);
    const ok = await SELF.fetch(`https://skiherd.jewell-labs.com/api/groups/${body.group_token}`, {
      headers: { authorization: `Bearer ${body.member_token}` },
    });
    expect(ok.status).toBe(200);
    const info = await ok.json<{ member_count: number }>();
    expect(info.member_count).toBe(1);
  });
});

describe("heartbeat validation (#9)", () => {
  it("does not store NaN or out-of-range coordinates", async () => {
    const group = stub("test-nan-hb-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    const res = await group.postHeartbeat(host.member_token, [
      { ts: new Date().toISOString(), lat: Number.NaN, lon: -105.76 },
      { ts: new Date().toISOString(), lat: 39.88, lon: Number.POSITIVE_INFINITY },
      { ts: new Date().toISOString(), lat: 39.88, lon: -105.76, alt_m: Number.NaN, speed_mps: 3 },
    ]);
    expect(res.accepted).toBe(1);
    const map = await group.groupMap(host.member_token);
    expect(map.members[0].lat).toBeCloseTo(39.88);
    expect(map.members[0].lon).toBeCloseTo(-105.76);
    expect(map.members[0].alt_m).toBeNull();
    expect(map.members[0].speed_mps).toBe(3);
  });
});

describe("member colors (#10)", () => {
  it("assigns a free color after a member leaves", async () => {
    const group = stub("test-color-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    const invite = await group.createInvite(host.member_token, { max_uses: 3 });
    const alex = await group.join(invite.invite_token, "Alex");
    const sam = await group.join(invite.invite_token, "Sam");
    const before = await group.groupMap(host.member_token);
    const colorsBefore = before.members.map((m) => m.color);
    expect(new Set(colorsBefore).size).toBe(3);

    await group.leave(host.member_token);
    const jordan = await group.join(invite.invite_token, "Jordan");
    const after = await group.groupMap(alex.member_token);
    const colors = after.members.map((m) => m.color);
    expect(after.members).toHaveLength(3);
    expect(new Set(colors).size).toBe(3);
    expect(after.members.find((m) => m.name === "Jordan")?.color).not.toBe(after.members.find((m) => m.name === "Alex")?.color);
    expect(after.members.find((m) => m.name === "Jordan")?.color).not.toBe(after.members.find((m) => m.name === "Sam")?.color);
    expect(jordan.member_token).toBeTruthy();
    expect(sam.member_token).toBeTruthy();
  });
});
