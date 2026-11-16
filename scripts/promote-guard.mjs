// Refuse a production promote that is missing a hostname, credentials, a closed
// rate-limit issue, or a staging deploy of this same sha and migration tag.
// Does not print the hostname, the account id, or a token.
import { readFileSync } from "node:fs";
import { hostnameRejection } from "./render-production-config.mjs";
import { parseJsonc } from "./lib/jsonc.mjs";

const args = process.argv.slice(2);

function flag(name) {
  let value;
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      value = args[i + 1];
      seen = true;
    }
  }
  return seen ? value : undefined;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const hostname = flag("--hostname");
const account = flag("--account-id");
const tokenPresent = flag("--token-present");
const issue18 = (flag("--issue-18-state") ?? "").toUpperCase();
const sha = flag("--sha") ?? "";
const recordPath = flag("--staging-record");
const migrationsPath = flag("--migrations-file");
const baselinePath = flag("--baseline-file") ?? new URL("./applied-migrations.json", import.meta.url);

const hostnameError = hostnameRejection(hostname);
if (hostnameError) fail(hostnameError);
if (typeof account !== "string" || account.trim() === "") fail("Cloudflare account id is not configured");
if (tokenPresent !== "1") fail("Cloudflare API token is not configured");
if (issue18 !== "CLOSED") fail("issue #18 is still open");
if (!/^[0-9a-f]{40}$/.test(sha)) fail("promote needs a 40-hex sha");
if (recordPath === undefined || recordPath === "") fail("staging deploy record is missing");

let record;
try {
  record = JSON.parse(readFileSync(recordPath, "utf8"));
} catch {
  fail("staging deploy record is missing");
}
if (record?.sha !== sha) fail("staging deploy record is for a different sha");

const config = migrationsPath
  ? { env: { staging: { migrations: JSON.parse(readFileSync(migrationsPath, "utf8")) } } }
  : parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const migrations = config?.env?.staging?.migrations;
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
if (!Array.isArray(migrations) || migrations.length === 0) fail("staging migrations are missing");
if (!Array.isArray(baseline) || baseline.length === 0) fail("applied migration baseline is missing");

const tags = migrations.map((entry) => entry?.tag);
if (tags.some((tag) => typeof tag !== "string" || tag === "") || new Set(tags).size !== tags.length) {
  fail("migration tags must be unique");
}
const prefix = JSON.stringify(migrations.slice(0, baseline.length));
if (prefix !== JSON.stringify(baseline)) fail("migrations are not append-only versus the last deployed list");

const lastTag = tags[tags.length - 1];
if (record?.migrationTag !== lastTag) fail("staging migration tag does not match the tag this promote would apply");
console.log("promote guards ok");
