import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SkiGroup } from "../src/group";
import { HEALTH_PROBE_PREFIX, runHealthcheck } from "../src/health";

function stub(name: string) {
  return env.GROUP.get(env.GROUP.idFromName(name));
}

describe("healthcheck", () => {
  it("passes in the test environment over HTTP and as a structured report", async () => {
    const res = await SELF.fetch("https://skiherd.jewell-labs.com/health");
    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      service: string;
      checked_at: string;
      components: Record<string, { ok: boolean; detail: string }>;
      advice: string[];
    }>();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("skiherd-groups");
    expect(body.advice).toEqual([]);
    expect(Number.isNaN(Date.parse(body.checked_at))).toBe(false);
    for (const name of ["worker", "durable_object", "storage", "alarm", "map_site", "osm_data", "rate_limiter", "server_time"]) {
      expect(body.components[name]?.ok, name).toBe(true);
      expect(body.components[name]?.detail).toBeTypeOf("string");
    }
    expect(body.components.osm_data.detail).toMatch(/trails/i);
    expect(body.components.server_time.detail).toBe(body.checked_at);
  });

  it("reports failure and advice when a component is broken", async () => {
    const probeFail = await runHealthcheck(env, new Request("https://skiherd.jewell-labs.com/health"), {
      probe: async () => {
        throw new Error("probe object unreachable");
      },
    });
    expect(probeFail.ok).toBe(false);
    expect(probeFail.components.durable_object.ok).toBe(false);
    expect(probeFail.components.storage.ok).toBe(false);
    expect(probeFail.components.alarm.ok).toBe(false);
    expect(probeFail.advice.join(" ")).toMatch(/Durable Object/i);

    const storageFail = await runHealthcheck(env, new Request("https://skiherd.jewell-labs.com/health"), {
      probe: async () => ({ storage_write: true, storage_read: false, alarm_scheduled: true }),
    });
    expect(storageFail.ok).toBe(false);
    expect(storageFail.components.storage.ok).toBe(false);
    expect(storageFail.components.durable_object.ok).toBe(true);
    expect(storageFail.advice.join(" ")).toMatch(/storage/i);

    const alarmFail = await runHealthcheck(env, new Request("https://skiherd.jewell-labs.com/health"), {
      probe: async () => ({ storage_write: true, storage_read: true, alarm_scheduled: false }),
    });
    expect(alarmFail.ok).toBe(false);
    expect(alarmFail.components.alarm.ok).toBe(false);

    const mapFail = await runHealthcheck(env, new Request("https://skiherd.jewell-labs.com/health"), {
      mapPage: async () => ({ ok: false, detail: "unexpected map HTML (status 500)" }),
    });
    expect(mapFail.ok).toBe(false);
    expect(mapFail.components.map_site.ok).toBe(false);
    expect(mapFail.advice.join(" ")).toMatch(/map/i);

    const osmFail = await runHealthcheck(env, new Request("https://skiherd.jewell-labs.com/health"), {
      trails: () => ({ trailCount: 0, liftCount: 0 }),
    });
    expect(osmFail.ok).toBe(false);
    expect(osmFail.components.osm_data.ok).toBe(false);

    const limiterFail = await runHealthcheck(env, new Request("https://skiherd.jewell-labs.com/health"), {
      rateLimiter: async () => ({ ok: false, detail: "limiter rejected the probe (retry in 60s)" }),
    });
    expect(limiterFail.ok).toBe(false);
    expect(limiterFail.components.rate_limiter.ok).toBe(false);
    expect(limiterFail.advice.length).toBeGreaterThan(0);
  });

  it("runs a probe on a health object and refuses to probe a user group", async () => {
    const probe = stub(`${HEALTH_PROBE_PREFIX}${crypto.randomUUID()}`);
    const result = await probe.healthProbe();
    expect(result).toEqual({ storage_write: true, storage_read: true, alarm_scheduled: true });

    const group = stub("test-health-guard-" + crypto.randomUUID());
    const host = await group.create("Tyler");
    await runInDurableObject(group, async (inst: SkiGroup) => {
      await expect(inst.healthProbe()).rejects.toThrow(/ephemeral health/i);
    });
    const still = await group.info(host.member_token);
    expect(still.member_count).toBe(1);
    await evictDurableObject(group);
  });
});
