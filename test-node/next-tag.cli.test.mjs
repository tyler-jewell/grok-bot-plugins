import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../scripts/next-tag.mjs", import.meta.url));
const A = "a".repeat(40);
const B = "b".repeat(40);

function run(args, input = "") {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const guardArgs = (o = {}) => {
  const v = {
    confirm: "promote-staging",
    ref: "refs/heads/main",
    sha: A,
    "main-head": A,
    "candidate-artifacts": "1",
    ...o,
  };
  return Object.entries(v).flatMap(([k, val]) => [`--${k}`, val]);
};

describe("next-tag.mjs guard", () => {
  it("passes when everything holds", () => {
    const r = run(["guard", ...guardArgs()]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("guards ok");
  });
  it("refuses a bad confirm", () => {
    const r = run(["guard", ...guardArgs({ confirm: "yes" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("confirm must equal promote-staging");
  });
  it("refuses a wrong ref", () => {
    const r = run(["guard", ...guardArgs({ ref: "refs/heads/feature" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("must run from refs/heads/main");
  });
  it("refuses a sha that is not the main head", () => {
    const r = run(["guard", ...guardArgs({ sha: B })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is not the current main head");
  });
  it("refuses zero candidate artifacts", () => {
    const r = run(["guard", ...guardArgs({ "candidate-artifacts": "0" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no candidate artifact");
  });
  it("refuses a missing or non-numeric candidate-artifacts count", () => {
    const args = guardArgs().slice(0, -2);
    expect(run(["guard", ...args]).code).toBe(1);
    expect(run(["guard", ...guardArgs({ "candidate-artifacts": "abc" })]).code).toBe(1);
  });
  it("no longer accepts the old staging-runs input", () => {
    const args = guardArgs().slice(0, -2).concat(["--staging-runs", "1"]);
    const r = run(["guard", ...args]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no candidate artifact");
  });
});

describe("next-tag.mjs plan", () => {
  const tags = `prod/2026.11.16+1 ${A}\nprod/2026.11.16+2 ${B}\n`;
  it("reports an already released sha", () => {
    const r = run(["plan", "--sha", B, "--date", "2026.11.16"], tags);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("released=prod/2026.11.16+2");
  });
  it("computes the next tag for a new sha", () => {
    const r = run(["plan", "--sha", "c".repeat(40), "--date", "2026.11.16"], tags);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("next=prod/2026.11.16+3");
  });
  it("starts at +1 on a new day", () => {
    const r = run(["plan", "--sha", "c".repeat(40), "--date", "2026.11.17"], tags);
    expect(r.out.trim()).toBe("next=prod/2026.11.17+1");
  });
});

describe("next-tag.mjs malformed invocation", () => {
  it("exits 2 with usage for an unknown command", () => {
    const r = run(["bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage");
  });
  it("exits 2 with usage for no command", () => {
    expect(run([]).code).toBe(2);
  });
  it("exits 2 on a flag without a value", () => {
    const r = run(["guard", "--confirm"]);
    expect(r.code).toBe(2);
  });
  it("exits 2 on a stray non-flag argument", () => {
    expect(run(["plan", "oops", "--sha", A]).code).toBe(2);
  });
  it("plan requires a 40-hex sha", () => {
    expect(run(["plan", "--sha", "nothex"], "").code).toBe(2);
    expect(run(["plan"], "").code).toBe(2);
  });
});
