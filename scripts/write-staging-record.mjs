// Write the staging deploy record. No account id, token, or hostname.
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

const sha = flag("--sha") ?? "";
const versionId = flag("--version-id") ?? "";
const migrationTag = flag("--migration-tag") ?? "";
const out = flag("--out");

if (!/^[0-9a-f]{40}$/.test(sha)) {
  console.error("staging record needs a 40-hex sha");
  process.exit(1);
}
if (versionId.trim() === "" || migrationTag.trim() === "" || out === undefined || out === "") {
  console.error("staging record needs a version id, migration tag, and output path");
  process.exit(1);
}

writeFileSync(out, `${JSON.stringify({ sha, versionId, migrationTag })}\n`);
