import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/promote-guard.mjs", import.meta.url));
const sha = "c".repeat(40);
const host = "groups.example.com";

function record(dir, body) {
  const file = join(dir, "staging-deploy.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

function run(extra) {
  const dir = mkdtempSync(join(tmpdir(), "promote-"));
  const args = [
    "--hostname", host,
    "--account-id", "acct-test",
    "--token-present", "1",
    "--issue-18-state", "CLOSED",
    "--sha", sha,
    "--staging-record", record(dir, { sha, versionId: "v", migrationTag: "v2" }),
    ...extra,
  ];
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { ...result, dir };
}

describe("promote-guard", () => {
  it("refuses an empty production hostname", () => {
    const result = run(["--hostname", ""]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/production hostname is empty/);
  });

  it("refuses a missing account id and does not print the hostname", () => {
    const result = run(["--account-id", ""]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/account id is not configured/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(host);
  });

  it("refuses a missing token", () => {
    const result = run(["--token-present", "0"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/API token is not configured/);
    expect(`${result.stdout}${result.stderr}`).not.toContain("acct-test");
  });

  it("refuses while issue 18 is open", () => {
    const result = run(["--issue-18-state", "OPEN"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/issue #18 is still open/);
  });

  it("refuses a staging record for a different sha", () => {
    const dir = mkdtempSync(join(tmpdir(), "promote-"));
    const result = run(["--staging-record", record(dir, { sha: "d".repeat(40), versionId: "v", migrationTag: "v1" })]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/different sha/);
  });

  it("refuses when the staging tag is not the tag this commit applies", () => {
    const dir = mkdtempSync(join(tmpdir(), "promote-"));
    const result = run(["--staging-record", record(dir, { sha, versionId: "v", migrationTag: "v0" })]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/migration tag does not match/);
  });

  it("refuses a migration list that is not append-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "promote-"));
    const migrations = join(dir, "migrations.json");
    writeFileSync(migrations, JSON.stringify([{ tag: "v2", new_sqlite_classes: ["SkiGroup"] }]));
    const result = run(["--migrations-file", migrations]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not append-only/);
  });

  it("passes for this repo when staging verified the same sha and tag", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("promote guards ok");
    expect(`${result.stdout}${result.stderr}`).not.toContain(host);
    expect(`${result.stdout}${result.stderr}`).not.toContain("acct-test");
  });
});

describe("release.yml production deploy", () => {
  const yml = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  it("replaces the placeholder and checks the hostname, issue 18, and staging record before deploy", () => {
    expect(yml).not.toContain("DEPLOY_TARGET");
    expect(yml).toContain("environment: production");
    expect(yml).toContain("vars.PRODUCTION_HOSTNAME");
    expect(yml).toContain("gh issue view 18");
    const guard = yml.indexOf("promote-guard.mjs");
    const deploy = yml.indexOf("wrangler deploy --config wrangler.production.jsonc");
    const health = yml.indexOf("check-health-sha.mjs");
    expect(guard).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(guard);
    expect(health).toBeGreaterThan(deploy);
    expect(yml).not.toMatch(/echo[^\n]*PRODUCTION_HOSTNAME/);
    expect(yml).not.toMatch(/echo[^\n]*CLOUDFLARE_API_TOKEN/);
  });
});
