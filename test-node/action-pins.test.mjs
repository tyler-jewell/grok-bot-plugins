import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveTag } from "../scripts/action-pins.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/action-pins.mjs");
const fixtures = join(root, "test-node/fixtures/pins");
const COMMIT = "1111111111111111111111111111111111111111";
const TAG_OBJECT = "3333333333333333333333333333333333333333";

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function pins(head, resolutions) {
  return run([
    "--base", join(fixtures, "empty.yml"),
    "--head", join(fixtures, head),
    "--resolutions", join(fixtures, resolutions),
  ]);
}

describe("action pins", () => {
  it("accepts a pin whose sha is the tag's commit", () => {
    const result = pins("match.yml", "lightweight.json");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects a pin of a different commit", () => {
    const result = pins("mismatch.yml", "lightweight.json");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=actions/checkout rule=sha-mismatch");
  });

  it("accepts an annotated tag only when the pin is the dereferenced commit", () => {
    const ok = pins("annotated-commit.yml", "annotated.json");
    expect(ok.status).toBe(0);
    const tagObject = pins("annotated-tag-object.yml", "annotated.json");
    expect(tagObject.status).not.toBe(0);
    expect(tagObject.stdout).toContain("package=actions/checkout rule=sha-mismatch");
  });

  it("rejects a pin that has no vX comment without calling the resolver", () => {
    const result = pins("missing-comment.yml", "empty.json");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=actions/checkout rule=missing-tag-comment");
  });

  it("does not resolve a uses line that the base already had", () => {
    const result = run([
      "--base", join(fixtures, "match.yml"),
      "--head", join(fixtures, "match.yml"),
      "--resolutions", join(fixtures, "empty.json"),
    ]);
    expect(result.status).toBe(0);
  });

  it("dereferences an annotated tag to the commit sha", async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (url.endsWith("/git/ref/tags/v7.0.1")) {
        return { ok: true, json: async () => ({ object: { type: "tag", sha: TAG_OBJECT } }) };
      }
      if (url.endsWith(`/git/tags/${TAG_OBJECT}`)) {
        return { ok: true, json: async () => ({ object: { type: "commit", sha: COMMIT } }) };
      }
      throw new Error(url);
    };
    const commit = await resolveTag("actions", "checkout", "v7.0.1", fetchImpl);
    expect(commit).toBe(COMMIT);
    expect(seen).toEqual([
      "https://api.github.com/repos/actions/checkout/git/ref/tags/v7.0.1",
      `https://api.github.com/repos/actions/checkout/git/tags/${TAG_OBJECT}`,
    ]);
  });

  it("checks a changed workflow through git show", () => {
    const dir = mkdtempSync(join(tmpdir(), "pins-git-"));
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
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    const workflow = join(dir, ".github/workflows/check.yml");
    writeFileSync(workflow, readFileSync(join(fixtures, "empty.yml")));
    git(["add", ".github/workflows/check.yml"]);
    git(["commit", "--no-gpg-sign", "-m", "base"]);
    writeFileSync(workflow, readFileSync(join(fixtures, "mismatch.yml")));
    git(["add", ".github/workflows/check.yml"]);
    git(["commit", "--no-gpg-sign", "-m", "head"]);
    const changed = join(dir, "changed.txt");
    writeFileSync(changed, ".github/workflows/check.yml\n");
    const result = run([
      "--repo", dir,
      "--base-rev", "HEAD~1",
      "--head-rev", "HEAD",
      "--changed", changed,
      "--resolutions", join(fixtures, "lightweight.json"),
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("package=actions/checkout rule=sha-mismatch");
  });
});
