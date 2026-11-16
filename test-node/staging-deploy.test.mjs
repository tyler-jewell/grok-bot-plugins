import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const sha = "a".repeat(40);
const other = "b".repeat(40);

function run(script, args) {
  const file = fileURLToPath(new URL(script, root));
  return spawnSync(process.execPath, [file, ...args], { encoding: "utf8" });
}

describe("require-cloudflare-credentials", () => {
  it("refuses a missing account id without printing it", () => {
    const result = run("scripts/require-cloudflare-credentials.mjs", ["--account-id", "", "--token-present", "1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/account id is not configured/);
  });

  it("refuses a missing token and does not echo the account id", () => {
    const result = run("scripts/require-cloudflare-credentials.mjs", ["--account-id", "acct-test", "--token-present", "0"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/API token is not configured/);
    expect(`${result.stdout}${result.stderr}`).not.toContain("acct-test");
  });

  it("passes when both are configured and prints neither", () => {
    const result = run("scripts/require-cloudflare-credentials.mjs", ["--account-id", "acct-test", "--token-present", "1"]);
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("acct-test");
  });
});

describe("check-health-sha", () => {
  const body = JSON.stringify({ components: { worker: { detail: `skiherd-groups@${sha}` } } });

  it("passes when the worker detail ends with the candidate sha", () => {
    const result = run("scripts/check-health-sha.mjs", ["--sha", sha, "--status", "200", "--body", body]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(sha);
  });

  it("fails when the sha does not match", () => {
    const result = run("scripts/check-health-sha.mjs", ["--sha", other, "--status", "200", "--body", body]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not match/);
  });

  it("fails on a non-200 response", () => {
    const result = run("scripts/check-health-sha.mjs", ["--sha", sha, "--status", "503", "--body", body]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/health status 503/);
  });
});

describe("deploy record helpers", () => {
  it("reads a wrangler version id and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "version-"));
    const file = join(dir, "deploy.out");
    writeFileSync(file, "Uploaded skiherd-groups-staging\nCurrent Version ID: 01234567-89ab-cdef-0123-456789abcdef\n");
    const result = run("scripts/read-version-id.mjs", [file]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("01234567-89ab-cdef-0123-456789abcdef");
  });

  it("fails when deploy output has no version id", () => {
    const dir = mkdtempSync(join(tmpdir(), "version-"));
    const file = join(dir, "deploy.out");
    writeFileSync(file, "deploy failed\n");
    const result = run("scripts/read-version-id.mjs", [file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no version id/);
  });

  it("prints the last staging migration tag", () => {
    const result = run("scripts/last-migration-tag.mjs", []);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("v1");
  });

  it("writes a record with sha, version id, and migration tag only", () => {
    const dir = mkdtempSync(join(tmpdir(), "record-"));
    const out = join(dir, "staging-deploy.json");
    const result = run("scripts/write-staging-record.mjs", [
      "--sha", sha,
      "--version-id", "01234567-89ab-cdef-0123-456789abcdef",
      "--migration-tag", "v1",
      "--out", out,
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      sha,
      versionId: "01234567-89ab-cdef-0123-456789abcdef",
      migrationTag: "v1",
    });
  });
});

describe("staging.yml deploy job", () => {
  const yml = readFileSync(new URL("../.github/workflows/staging.yml", import.meta.url), "utf8");

  it("deploys only after the candidate, with the staging environment, and fails closed first", () => {
    expect(yml).toMatch(/deploy:[\s\S]*needs:\s*candidate/);
    expect(yml).toMatch(/environment:\s*staging/);
    expect(yml).not.toContain("pull_request_target");
    const refuse = yml.indexOf("require-cloudflare-credentials.mjs");
    const deploy = yml.indexOf("wrangler deploy --env staging");
    const health = yml.indexOf("check-health-sha.mjs");
    expect(refuse).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(refuse);
    expect(health).toBeGreaterThan(deploy);
    expect(yml).toContain("secrets.CLOUDFLARE_API_TOKEN");
    expect(yml).toContain("vars.CLOUDFLARE_ACCOUNT_ID");
    expect(yml).not.toMatch(/echo[^\n]*CLOUDFLARE_API_TOKEN/);
    expect(yml).toContain("https://skiherd-groups.jewell-labs.com/health");
    expect(yml).toContain("staging-deploy-${{ github.event.workflow_run.head_sha }}");
  });
});
