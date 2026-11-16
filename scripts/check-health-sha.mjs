// Compare a /health response to the commit that was deployed.
// Usage: node scripts/check-health-sha.mjs --sha SHA --status CODE --body JSON
//        node scripts/check-health-sha.mjs --sha SHA --status CODE --body-file PATH
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

const sha = flag("--sha") ?? "";
const status = Number(flag("--status"));
const body = flag("--body-file") !== undefined ? readFileSync(flag("--body-file"), "utf8") : flag("--body");

if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error("health check needs a 40-hex sha");
  process.exit(1);
}
if (!Number.isInteger(status)) {
  console.error("health check needs an HTTP status");
  process.exit(1);
}
if (status !== 200) {
  console.error(`health status ${status} does not match the candidate`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(body ?? "");
} catch {
  console.error("health body is not JSON");
  process.exit(1);
}

const detail = parsed?.components?.worker?.detail;
if (typeof detail !== "string" || !detail.endsWith(`@${sha}`)) {
  console.error("health sha does not match the candidate");
  process.exit(1);
}
console.log(`health sha matched ${sha}`);
