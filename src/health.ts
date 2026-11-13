import { allLifts, allTrails } from "./mountain";
import { rateLimit } from "./rate-limit";
import { BUILD_INFO } from "./skills.generated";

export const HEALTH_PROBE_PREFIX = "__skiherd_health__";

export type ComponentResult = {
  ok: boolean;
  detail: string;
  advice?: string;
};

export type HealthReport = {
  ok: boolean;
  service: "skiherd-groups";
  checked_at: string;
  components: {
    worker: ComponentResult;
    durable_object: ComponentResult;
    storage: ComponentResult;
    alarm: ComponentResult;
    map_site: ComponentResult;
    osm_data: ComponentResult;
    rate_limiter: ComponentResult;
    server_time: ComponentResult;
  };
  advice: string[];
};

export type HealthDependencies = {
  probe?: () => Promise<{ storage_write: boolean; storage_read: boolean; alarm_scheduled: boolean }>;
  mapPage?: () => Promise<{ ok: boolean; detail: string }>;
  rateLimiter?: () => Promise<{ ok: boolean; detail: string }>;
  trails?: () => { trailCount: number; liftCount: number };
  now?: () => Date;
  gitSha?: string;
};

function fail(detail: string, advice: string): ComponentResult {
  return { ok: false, detail, advice };
}

function pass(detail: string): ComponentResult {
  return { ok: true, detail };
}

export async function runHealthcheck(env: Env, request: Request, deps: HealthDependencies = {}): Promise<HealthReport> {
  const now = deps.now ? deps.now() : new Date();
  const gitSha = deps.gitSha ?? env.GIT_SHA ?? BUILD_INFO.gitSha ?? "local";

  const worker = pass(`skiherd-groups@${gitSha}`);

  let durable_object: ComponentResult = fail("not checked", "Retry healthcheck. If it still fails, the group Durable Object namespace is not reachable.");
  let storage: ComponentResult = fail("not checked", "Retry healthcheck. If it still fails, Durable Object storage is not writable.");
  let alarm: ComponentResult = fail("not checked", "Retry healthcheck. If it still fails, 24-hour self-delete alarms may not schedule.");

  try {
    const probe = deps.probe
      ? await deps.probe()
      : await env.GROUP.get(env.GROUP.idFromName(`${HEALTH_PROBE_PREFIX}${crypto.randomUUID()}`)).healthProbe();
    durable_object = pass("ephemeral probe object reached (no user data kept)");
    storage = probe.storage_write && probe.storage_read
      ? pass("write and read succeeded; probe storage wiped")
      : fail(
          `write=${probe.storage_write} read=${probe.storage_read}`,
          "Durable Object storage failed a write or read. Do not create a group until this passes.",
        );
    alarm = probe.alarm_scheduled
      ? pass("alarm scheduled on the probe object, then cleared")
      : fail("alarm did not schedule", "The 24-hour self-delete alarm could not be scheduled. Do not rely on automatic deletion until this passes.");
  } catch (err) {
    const message = err instanceof Error ? err.message : "probe failed";
    durable_object = fail(message, "The group Durable Object could not be reached. Stop and tell the human. Retry later.");
    storage = fail("skipped because the probe object was unreachable", durable_object.advice ?? "");
    alarm = fail("skipped because the probe object was unreachable", durable_object.advice ?? "");
  }

  let map_site: ComponentResult;
  try {
    const page = deps.mapPage
      ? await deps.mapPage()
      : await (async () => {
          const res = await env.ASSETS.fetch(new URL("/group.html", request.url));
          const text = await res.text();
          const ok = res.ok && text.includes("SkiHerd") && text.includes("OpenStreetMap");
          return { ok, detail: ok ? `group map HTML ${res.status}` : `unexpected map HTML (status ${res.status})` };
        })();
    map_site = page.ok ? pass(page.detail) : fail(page.detail, "The map site could not be served. Do not send the human a map link until this passes.");
  } catch (err) {
    map_site = fail(err instanceof Error ? err.message : "map fetch failed", "The map site could not be served. Do not send the human a map link until this passes.");
  }

  let osm_data: ComponentResult;
  try {
    const counts = deps.trails ? deps.trails() : { trailCount: allTrails().length, liftCount: allLifts().length };
    osm_data =
      counts.trailCount > 0 && counts.liftCount > 0
        ? pass(`${counts.trailCount} downhill trails, ${counts.liftCount} lifts (bundled OSM extract)`)
        : fail("Winter Park OSM extract is empty", "Trail and lift data failed to load. runs_not_hit and suggest_new_route will not work.");
  } catch (err) {
    osm_data = fail(err instanceof Error ? err.message : "OSM load failed", "Trail and lift data failed to load.");
  }

  let rate_limiter: ComponentResult;
  try {
    const result = deps.rateLimiter
      ? await deps.rateLimiter()
      : await (async () => {
          const cap = Number(env.CREATE_GROUP_PER_IP_PER_HOUR ?? 5);
          const rl = await rateLimit(caches.default, "healthcheck:probe", 1000, 60_000);
          return {
            ok: rl.ok,
            detail: rl.ok
              ? `limiter reachable; create_group cap ${cap} per IP per hour; max members ${env.MAX_GROUP_MEMBERS ?? 10}`
              : `limiter rejected the probe (retry in ${"retryAfterSec" in rl ? rl.retryAfterSec : "?" }s)`,
          };
        })();
    rate_limiter = result.ok
      ? pass(result.detail)
      : fail(result.detail, "The rate limiter is blocking checks. Wait and retry, or tell the human the public endpoint may be saturated.");
  } catch (err) {
    rate_limiter = fail(err instanceof Error ? err.message : "rate limiter failed", "The application rate limiter could not be contacted.");
  }

  const server_time = pass(now.toISOString());

  const components = { worker, durable_object, storage, alarm, map_site, osm_data, rate_limiter, server_time };
  const advice = Object.values(components)
    .filter((c) => !c.ok && c.advice)
    .map((c) => c.advice as string);
  const ok = Object.values(components).every((c) => c.ok);
  if (!ok && advice.length === 0) advice.push("One or more components failed. Stop and tell the human. Do not act on a group.");

  return { ok, service: "skiherd-groups", checked_at: now.toISOString(), components, advice: ok ? [] : advice };
}
