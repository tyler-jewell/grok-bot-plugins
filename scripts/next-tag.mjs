#!/usr/bin/env node
// CLI used by .github/workflows/release.yml. Logic lives in scripts/lib/release.mjs.
//   guard --confirm C --ref R --sha S --main-head H --staging-runs N   (exit 1 on refusal)
//   plan  --sha S [--date YYYY.MM.DD]   (tags as "<tag> <commit>" lines on stdin)
//         prints released=<tag> or next=<tag>
import { readFileSync } from "node:fs";
import { checkGuards, findReleased, formatDate, nextTag, parseTags } from "./lib/release.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const a = {};
for (let i = 0; i < rest.length; i += 2) a[rest[i].replace(/^--/, "")] = rest[i + 1];

if (cmd === "guard") {
  const r = checkGuards({
    confirm: a.confirm,
    ref: a.ref,
    sha: a.sha,
    mainHead: a["main-head"],
    stagingRuns: Number(a["staging-runs"]),
  });
  if (!r.ok) {
    console.error(`Refusing to promote: ${r.reason}`);
    process.exit(1);
  }
  console.log("guards ok");
} else if (cmd === "plan") {
  const tags = parseTags(readFileSync(0, "utf8"));
  const released = findReleased(tags, a.sha);
  console.log(released ? `released=${released}` : `next=${nextTag(tags, a.date ?? formatDate(new Date()))}`);
} else {
  console.error("usage: next-tag.mjs guard|plan ...");
  process.exit(2);
}
