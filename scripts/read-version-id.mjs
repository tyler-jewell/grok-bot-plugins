// Print the Worker version id from wrangler deploy output. Prints nothing else.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/read-version-id.mjs <deploy-output>");
  process.exit(2);
}
const text = readFileSync(file, "utf8");
const match = text.match(/Current Version ID:\s*(\S+)/);
if (!match) {
  console.error("deploy output has no version id");
  process.exit(1);
}
console.log(match[1]);
