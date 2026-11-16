#!/usr/bin/env node
// Render a production wrangler config with one custom-domain route.
// Hostname: --hostname, else PRODUCTION_HOSTNAME. Never reads the committed file for it.
// Exits 1 when the hostname is empty or not a plain hostname (no scheme, path, port, or wildcard).
// Refuses the staging hostname so a promote cannot retarget staging.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lib/jsonc.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGING_HOSTNAME = "skiherd-groups.jewell-labs.com";
// At least two DNS labels, lowercase, no trailing dot. Custom domains cannot be a single label.
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/;

/** @returns {string | null} a rejection message, or null when the hostname may be rendered. */
export function hostnameRejection(raw) {
  if (raw === undefined || raw === null || raw === "") return "production hostname is empty";
  if (typeof raw !== "string" || /\s/.test(raw)) return "production hostname must not contain whitespace";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("//")) {
    return "production hostname must be a plain hostname, not a URL with a scheme";
  }
  if (raw.includes("/")) return "production hostname must not include a path";
  if (raw.includes("*")) return "production hostname must not include a wildcard";
  if (raw.toLowerCase() === STAGING_HOSTNAME) {
    return `production hostname must not be the staging hostname ${STAGING_HOSTNAME}`;
  }
  if (!HOSTNAME_RE.test(raw)) return "production hostname must be a plain hostname";
  return null;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function usage(message) {
  fail(`${message}\nusage: render-production-config.mjs [--hostname HOST] [--out FILE]`, 2);
}

function parseArgs(argv) {
  let hostname;
  let hostnameSet = false;
  let outPath;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--hostname") {
      const value = argv[++i];
      if (value === undefined) usage("missing value for --hostname");
      hostname = value;
      hostnameSet = true;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (value === undefined || value === "") usage("missing value for --out");
      outPath = value;
    } else if (arg.startsWith("--")) {
      usage(`unexpected argument: ${arg}`);
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }
  return { hostname: hostnameSet ? hostname : process.env.PRODUCTION_HOSTNAME, outPath };
}

function absolutize(value) {
  if (typeof value !== "string" || value === "") return value;
  return path.resolve(ROOT, value);
}

export function renderProductionConfig(config, hostname) {
  const rendered = structuredClone(config);
  // Promote deploys this file without --env. Drop staging so the only route is production.
  delete rendered.env;
  delete rendered.route;
  if (typeof rendered.main === "string") rendered.main = absolutize(rendered.main);
  if (rendered.assets && typeof rendered.assets.directory === "string") {
    rendered.assets.directory = absolutize(rendered.assets.directory);
  }
  if (typeof rendered.$schema === "string") rendered.$schema = absolutize(rendered.$schema);
  rendered.routes = [{ pattern: hostname, custom_domain: true }];
  rendered.vars = { ...(rendered.vars ?? {}), PUBLIC_BASE_URL: `https://${hostname}` };
  return rendered;
}

function main() {
  const { hostname, outPath } = parseArgs(process.argv.slice(2));
  const rejection = hostnameRejection(hostname);
  if (rejection) fail(rejection);
  const source = parseJsonc(readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8"));
  const rendered = renderProductionConfig(source, hostname);
  const json = `${JSON.stringify(rendered, null, 2)}\n`;
  if (outPath) writeFileSync(outPath, json);
  else process.stdout.write(json);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
