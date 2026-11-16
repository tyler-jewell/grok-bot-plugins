import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../scripts/lib/jsonc.mjs";

const config = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const baseline = JSON.parse(readFileSync(new URL("../scripts/applied-migrations.json", import.meta.url), "utf8"));

const STAGING_HOST = "skiherd-groups.jewell-labs.com";
const ALLOWED_APPS = new Set(["skiherd-groups", "skiherd-groups-staging"]);
const FORBIDDEN_ROUTE_HOST = "skiherd.jewell-labs.com";

/** A jewell-labs host other than the staging hostname. Production hosts must not be committed. */
function isJewellLabsProductionHost(value) {
  if (typeof value !== "string" || value === "") return false;
  let host = value.trim();
  try {
    host = new URL(value).hostname;
  } catch {
    host = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0].split(":")[0];
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host === STAGING_HOST) return false;
  return host === "jewell-labs.com" || host.endsWith(".jewell-labs.com");
}

function routePatterns(section) {
  if (!section || typeof section !== "object") return [];
  const out = [];
  if (section.route !== undefined) out.push(section.route);
  if (Array.isArray(section.routes)) out.push(...section.routes);
  return out.map((route) => (typeof route === "string" ? route : route?.pattern));
}

function routeHost(pattern) {
  if (typeof pattern !== "string") return "";
  let host = pattern.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = host.indexOf("/");
  if (slash !== -1) host = host.slice(0, slash);
  return host.split(":")[0].toLowerCase().replace(/\.$/, "");
}

function sections() {
  const out = [["top-level", config]];
  for (const [name, env] of Object.entries(config.env ?? {})) out.push([`env.${name}`, env]);
  return out;
}

function disallowedSkiherdTokens(text) {
  const bad = [];
  for (const match of text.matchAll(/skiherd(?:-groups(?:-staging)?)?/g)) {
    if (match[0] !== "skiherd-groups" && match[0] !== "skiherd-groups-staging") bad.push(match[0]);
  }
  return bad;
}

function assertAppendOnlyMigrations(migrations, label) {
  expect(Array.isArray(migrations), label).toBe(true);
  const tags = migrations.map((entry) => entry.tag);
  expect(new Set(tags).size, `${label} tags are unique`).toBe(tags.length);
  const versions = tags.filter((tag) => /^v[1-9]\d*$/.test(tag)).map((tag) => Number(tag.slice(1)));
  for (let i = 1; i < versions.length; i++) {
    expect(versions[i], `${label} tags are in order`).toBeGreaterThan(versions[i - 1]);
  }
  expect(migrations.slice(0, baseline.length), `${label} is append-only vs the applied tag list`).toEqual(baseline);
  const v1 = migrations.find((entry) => entry.tag === "v1");
  const appliedV1 = baseline.find((entry) => entry.tag === "v1");
  expect(v1, `${label} v1`).toEqual(appliedV1);
}

describe("wrangler.jsonc has no committed production route", () => {
  it("has no top-level route or routes", () => {
    expect("route" in config).toBe(false);
    expect("routes" in config).toBe(false);
  });

  it("has no jewell-labs production PUBLIC_BASE_URL at the top level", () => {
    expect(isJewellLabsProductionHost(config.vars?.PUBLIC_BASE_URL)).toBe(false);
    expect(config.vars?.PUBLIC_BASE_URL).toBeUndefined();
  });

  it("does not route skiherd.jewell-labs.com from any environment", () => {
    const patterns = sections().flatMap(([, section]) => routePatterns(section));
    for (const pattern of patterns) {
      expect(routeHost(pattern)).not.toBe(FORBIDDEN_ROUTE_HOST);
      expect(pattern).not.toBe(FORBIDDEN_ROUTE_HOST);
    }
  });

  it("does not put account_id in the config", () => {
    expect(JSON.stringify(config)).not.toContain("account_id");
  });
});

describe("env.staging is the only committed environment", () => {
  const staging = config.env?.staging;

  it("names the staging Worker and its custom domain", () => {
    expect(staging?.name).toBe("skiherd-groups-staging");
    expect(staging?.workers_dev).toBe(false);
    expect(config.workers_dev).toBe(false);
    expect(staging?.routes).toEqual([{ pattern: STAGING_HOST, custom_domain: true }]);
    expect(staging?.vars?.PUBLIC_BASE_URL).toBe(`https://${STAGING_HOST}`);
  });

  it("redeclares the Durable Object binding and v1 migration", () => {
    expect(staging?.durable_objects?.bindings).toEqual([{ name: "GROUP", class_name: "SkiGroup" }]);
    expect(staging?.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["SkiGroup"] }]);
  });

  it("redeclares non-inherited vars so staging does not drop them", () => {
    expect(staging?.vars?.GROUP_TTL_MS).toBe(config.vars.GROUP_TTL_MS);
    expect(staging?.vars?.MAX_GROUP_MEMBERS).toBe(config.vars.MAX_GROUP_MEMBERS);
    expect(staging?.vars?.CREATE_GROUP_PER_IP_PER_HOUR).toBe(config.vars.CREATE_GROUP_PER_IP_PER_HOUR);
    expect(staging?.vars?.JOIN_PER_IP_PER_HOUR).toBe(config.vars.JOIN_PER_IP_PER_HOUR);
    expect(staging?.vars?.INVITE_PER_IP_PER_HOUR).toBe(config.vars.INVITE_PER_IP_PER_HOUR);
    expect(staging?.vars?.HEARTBEAT_PER_IP_PER_HOUR).toBe(config.vars.HEARTBEAT_PER_IP_PER_HOUR);
    expect(staging?.vars?.MAX_HEARTBEATS_PER_GROUP).toBe(config.vars.MAX_HEARTBEATS_PER_GROUP);
    expect(staging?.vars?.GIT_SHA).toBe(config.vars.GIT_SHA);
  });

  it("has no other routes", () => {
    const patterns = sections().flatMap(([, section]) => routePatterns(section));
    expect(patterns).toEqual([STAGING_HOST]);
  });
});

describe("bindings and routes stay on this app", () => {
  it("only names skiherd-groups or skiherd-groups-staging", () => {
    expect(ALLOWED_APPS.has(config.name)).toBe(true);
    for (const [label, section] of sections()) {
      if (label === "top-level") continue;
      const name = typeof section.name === "string" ? section.name : `${config.name}-${label.slice(4)}`;
      expect(ALLOWED_APPS.has(name), label).toBe(true);
      const hostLabel = (pattern) => {
        const host = routeHost(pattern);
        if (!host.endsWith(".jewell-labs.com")) return null;
        return host.slice(0, -".jewell-labs.com".length);
      };
      for (const pattern of routePatterns(section)) {
        const labelName = hostLabel(pattern);
        if (labelName !== null) expect(ALLOWED_APPS.has(labelName), pattern).toBe(true);
      }
    }
    const problems = [];
    const walk = (node, where) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${where}[${index}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const key of ["service", "script_name"]) {
        if (typeof node[key] === "string" && !ALLOWED_APPS.has(node[key])) {
          problems.push(`${where}.${key}=${node[key]}`);
        }
      }
      for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`);
    };
    walk(config, "config");
    expect(problems).toEqual([]);
    expect(disallowedSkiherdTokens(JSON.stringify(config))).toEqual([]);
  });
});

describe("migrations stay append-only", () => {
  it("keeps the applied baseline itself ordered and unique", () => {
    const tags = baseline.map((entry) => entry.tag);
    expect(new Set(tags).size).toBe(tags.length);
    expect(baseline[0]).toEqual({ tag: "v1", new_sqlite_classes: ["SkiGroup"] });
  });

  it("matches the committed applied tag list at the top level and on staging", () => {
    assertAppendOnlyMigrations(config.migrations, "top-level");
    assertAppendOnlyMigrations(config.env.staging.migrations, "env.staging");
  });
});

