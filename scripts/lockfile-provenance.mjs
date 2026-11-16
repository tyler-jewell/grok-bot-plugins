// Compare two npm lockfiles. Flag a new or changed package whose tarball is not
// from registry.npmjs.org, whose integrity is missing, or that gained an
// install script. Paths outside the dependency files fail closed.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REGISTRY_HOST = "registry.npmjs.org";

function flag(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
  }
  return undefined;
}

function allowedPath(file) {
  if (file.includes("\\") || file.startsWith("/") || file.split("/").includes("..")) return false;
  if (file === "package.json" || file === "package-lock.json") return true;
  return file.startsWith(".github/workflows/") && file.length > ".github/workflows/".length;
}

function signature(entry) {
  if (entry === undefined) return null;
  return JSON.stringify({
    version: entry.version ?? null,
    resolved: entry.resolved ?? null,
    integrity: entry.integrity ?? null,
    hasInstallScript: entry.hasInstallScript === true,
  });
}

function schemeViolation(resolved) {
  if (typeof resolved !== "string" || resolved.length === 0) return true;
  if (/^(git\+|github:|file:|git:|ssh:|http:)/i.test(resolved)) return true;
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return true;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return true;
  return false;
}

function packageRules(key, before, after) {
  const violations = [];
  const resolved = after.resolved;
  if (schemeViolation(resolved)) {
    violations.push({ package: key, rule: "resolved-scheme" });
  } else {
    const url = new URL(resolved);
    if (url.hostname !== REGISTRY_HOST) {
      violations.push({ package: key, rule: "registry-host" });
      if (/\.(?:tgz|tar\.gz)$/i.test(url.pathname)) {
        violations.push({ package: key, rule: "non-registry-tarball" });
      }
    }
  }
  if (typeof after.integrity !== "string" || !after.integrity.startsWith("sha")) {
    violations.push({ package: key, rule: "missing-integrity" });
  }
  const gainedScript = after.hasInstallScript === true && before?.hasInstallScript !== true;
  if (gainedScript) violations.push({ package: key, rule: "install-script" });
  return violations;
}

export function provenanceViolations({ baseText, headText, changedFiles }) {
  const violations = [];
  for (const file of changedFiles) {
    if (!allowedPath(file)) violations.push({ package: file, rule: "changed-path" });
  }
  let base;
  let head;
  try {
    base = JSON.parse(baseText);
    head = JSON.parse(headText);
  } catch {
    violations.push({ package: "package-lock.json", rule: "lockfile-json" });
    return violations;
  }
  const basePackages = base.packages ?? {};
  const headPackages = head.packages ?? {};
  const keys = new Set([...Object.keys(basePackages), ...Object.keys(headPackages)]);
  for (const key of keys) {
    if (key === "") continue;
    const before = basePackages[key];
    const after = headPackages[key];
    if (after === undefined || signature(before) === signature(after)) continue;
    if (after.link === true) continue;
    violations.push(...packageRules(key, before, after));
  }
  violations.sort((a, b) => `${a.package}\0${a.rule}`.localeCompare(`${b.package}\0${b.rule}`));
  return violations;
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
      console.log("package=package-lock.json rule=lockfile-json");
      process.exit(1);
    }
  } else {
    console.error("usage: lockfile-provenance.mjs (--base <file> --head <file> | --repo <dir> --base-rev <rev> --head-rev <rev>) [--changed <file>]");
    process.exit(2);
  }
  const violations = provenanceViolations({ baseText, headText, changedFiles });
  for (const violation of violations) {
    console.log(`package=${violation.package} rule=${violation.rule}`);
  }
  if (violations.length > 0) process.exit(1);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
