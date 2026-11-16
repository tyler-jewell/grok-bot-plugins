// Classify a Dependabot lockfile diff. Patch and non-breaking minor npm bumps
// are `auto`. Majors, 0.x minors, install-script bumps, and workflow edits are
// `review`. Install scripts come from the lockfile's hasInstallScript field.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function flag(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
  }
  return undefined;
}

function parseVersion(version) {
  if (typeof version !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? "",
  };
}

export function bumpKind(from, to) {
  const before = parseVersion(from);
  const after = parseVersion(to);
  if (before === null || after === null) return "unparsed";
  if (before.pre !== "" || after.pre !== "") return "prerelease";
  if (before.major !== after.major) return "major";
  if (before.minor !== after.minor) return before.major === 0 ? "zero-minor" : "minor";
  if (before.patch !== after.patch) return "patch";
  return "same";
}

function signature(entry) {
  return JSON.stringify({
    version: entry.version ?? null,
    resolved: entry.resolved ?? null,
    integrity: entry.integrity ?? null,
    hasInstallScript: entry.hasInstallScript === true,
  });
}

export function classifyDecision({ baseText, headText, changedFiles }) {
  let review = false;
  let autoBumps = 0;
  for (const file of changedFiles) {
    if (file.startsWith(".github/workflows/")) review = true;
  }
  const base = JSON.parse(baseText);
  const head = JSON.parse(headText);
  const basePackages = base.packages ?? {};
  const headPackages = head.packages ?? {};
  const keys = new Set([...Object.keys(basePackages), ...Object.keys(headPackages)]);
  for (const key of keys) {
    if (key === "") continue;
    const before = basePackages[key];
    const after = headPackages[key];
    if (before !== undefined && after === undefined) {
      review = true;
      continue;
    }
    if (after === undefined) continue;
    if (before === undefined) {
      if (after.hasInstallScript === true) review = true;
      continue;
    }
    if (signature(before) === signature(after)) continue;
    if (before.version === after.version) {
      review = true;
      continue;
    }
    const kind = bumpKind(before.version, after.version);
    const scripted = before.hasInstallScript === true || after.hasInstallScript === true;
    if (scripted || (kind !== "patch" && kind !== "minor")) review = true;
    else autoBumps += 1;
  }
  if (review || autoBumps === 0) return "review";
  return "auto";
}

function gitShow(repo, rev, file) {
  const result = spawnSync("git", ["-C", repo, "show", `${rev}:${file}`], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout;
}

function readChanged(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function main() {
  const args = process.argv.slice(2);
  const base = flag(args, "--base");
  const head = flag(args, "--head");
  const repo = flag(args, "--repo");
  const baseRev = flag(args, "--base-rev");
  const headRev = flag(args, "--head-rev");
  const changed = flag(args, "--changed");
  const changedFiles = changed === undefined ? [] : readChanged(changed);
  let baseText;
  let headText;
  if (base !== undefined && head !== undefined) {
    baseText = readFileSync(base, "utf8");
    headText = readFileSync(head, "utf8");
  } else if (repo !== undefined && baseRev !== undefined && headRev !== undefined) {
    baseText = gitShow(repo, baseRev, "package-lock.json");
    headText = gitShow(repo, headRev, "package-lock.json");
    if (baseText === null || headText === null) {
      console.error("package=package-lock.json rule=lockfile-json");
      process.exit(2);
    }
  } else {
    console.error("usage: dependabot-class.mjs (--base <file> --head <file> | --repo <dir> --base-rev <rev> --head-rev <rev>) [--changed <file>]");
    process.exit(2);
  }
  let decision;
  try {
    decision = classifyDecision({ baseText, headText, changedFiles });
  } catch {
    console.error("package=package-lock.json rule=lockfile-json");
    process.exit(2);
  }
  console.log(decision);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
