import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/lockfile-provenance.mjs");
const fixtures = join(root, "test-node/fixtures/provenance");
const realLock = join(root, "package-lock.json");

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function provenance(head, changed) {
  const args = ["--base", join(fixtures, "base.json"), "--head", join(fixtures, head)];
  if (changed !== undefined) args.push("--changed", join(fixtures, changed));
  return run(args);
}

describe("lockfile provenance", () => {
  it("accepts a clean registry bump", () => {
    const result = provenance("clean.json", "allowed.txt");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects a new package that runs an install script", () => {
    const result = provenance("install-script.json", "allowed.txt");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=node_modules/evil rule=install-script");
  });

  it("rejects a git URL", () => {
    const result = provenance("git-url.json");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=node_modules/left-pad rule=resolved-scheme");
  });

  it("rejects a non-registry tarball", () => {
    const result = provenance("tarball.json");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=node_modules/left-pad rule=non-registry-tarball");
  });

  it("rejects a resolved host other than the npm registry", () => {
    const result = provenance("foreign-host.json");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=node_modules/left-pad rule=registry-host");
    expect(result.stdout).not.toContain("non-registry-tarball");
  });

  it("rejects a changed package with no integrity", () => {
    const result = provenance("missing-integrity.json");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=node_modules/left-pad rule=missing-integrity");
  });

  it("rejects a changed path outside the dependency files", () => {
    const result = provenance("clean.json", "unrelated.txt");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=src/index.ts rule=changed-path");
  });

  it("accepts the committed lockfile compared with itself", () => {
    const result = run(["--base", realLock, "--head", realLock]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("does not fail a version bump of a package that already runs an install script", () => {
    const json = JSON.parse(readFileSync(realLock, "utf8"));
    const key = Object.keys(json.packages).find((name) => json.packages[name].hasInstallScript === true);
    expect(key).toBeTruthy();
    const head = structuredClone(json);
    const entry = head.packages[key];
    const from = entry.version;
    const next = from.replace(/(\d+)$/, (patch) => String(Number(patch) + 1));
    entry.version = next;
    entry.resolved = entry.resolved.replace(`-${from}.tgz`, `-${next}.tgz`);
    const dir = mkdtempSync(join(tmpdir(), "provenance-"));
    const headFile = join(dir, "head.json");
    writeFileSync(headFile, JSON.stringify(head));
    const result = run(["--base", realLock, "--head", headFile, "--changed", join(fixtures, "allowed.txt")]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("reads the lockfiles with git show when given revisions", () => {
    const dir = mkdtempSync(join(tmpdir(), "provenance-git-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Provenance Test",
      GIT_AUTHOR_EMAIL: "provenance-test@example.com",
      GIT_COMMITTER_NAME: "Provenance Test",
      GIT_COMMITTER_EMAIL: "provenance-test@example.com",
    };
    const git = (args) => {
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    };
    git(["init", "-b", "main"]);
    writeFileSync(join(dir, "package-lock.json"), readFileSync(join(fixtures, "base.json")));
    git(["add", "package-lock.json"]);
    git(["commit", "--no-gpg-sign", "-m", "base"]);
    writeFileSync(join(dir, "package-lock.json"), readFileSync(join(fixtures, "git-url.json")));
    git(["add", "package-lock.json"]);
    git(["commit", "--no-gpg-sign", "-m", "head"]);
    const changed = join(dir, "changed.txt");
    writeFileSync(changed, "package-lock.json\n");
    const result = run(["--repo", dir, "--base-rev", "HEAD~1", "--head-rev", "HEAD", "--changed", changed]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=node_modules/left-pad rule=resolved-scheme");
  });
});
