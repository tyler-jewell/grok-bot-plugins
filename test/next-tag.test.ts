// @ts-expect-error plain JS module shared with the release workflow
import { checkGuards, findReleased, formatDate, nextTag, parseTags } from "../scripts/lib/release.mjs";
import { describe, expect, it } from "vitest";

const A = "a".repeat(40);
const B = "b".repeat(40);
const lines = (...l: string[]) => parseTags(l.join("\n"));

describe("nextTag", () => {
  it("starts at +1 for the first tag of the day", () => {
    expect(nextTag([], "2026.11.16")).toBe("prod/2026.11.16+1");
  });
  it("increments past the highest existing suffix, not the count", () => {
    const tags = lines(`prod/2026.11.16+1 ${A}`, `prod/2026.11.16+9 ${A}`, `prod/2026.11.16+10 ${B}`);
    expect(nextTag(tags, "2026.11.16")).toBe("prod/2026.11.16+11");
  });
  it("ignores other days", () => {
    const tags = lines(`prod/2026.11.15+7 ${A}`, `prod/2026.11.17+3 ${A}`);
    expect(nextTag(tags, "2026.11.16")).toBe("prod/2026.11.16+1");
  });
  it("ignores malformed tags", () => {
    const tags = lines(
      `prod/2026.11.16+x ${A}`,
      `prod/2026.11.16+ ${A}`,
      `prod/2026.11.16+0 ${A}`,
      `prod/2026.11.16+1extra ${A}`,
      `v2026.11.16+50 ${A}`,
      `prod/2026.11.16 ${A}`,
      `prod/2026.11.16+2 ${A}`,
    );
    expect(nextTag(tags, "2026.11.16")).toBe("prod/2026.11.16+3");
  });
});

describe("findReleased", () => {
  it("returns the tag pointing at the sha", () => {
    expect(findReleased(lines(`prod/2026.11.16+1 ${A}`, `prod/2026.11.16+2 ${B}`), B)).toBe("prod/2026.11.16+2");
  });
  it("returns null when the sha has no tag", () => {
    expect(findReleased(lines(`prod/2026.11.16+1 ${A}`), B)).toBeNull();
  });
  it("ignores malformed tags pointing at the sha", () => {
    expect(findReleased(lines(`prod/nonsense ${B}`, `other/2026.11.16+1 ${B}`), B)).toBeNull();
  });
});

describe("parseTags / formatDate", () => {
  it("skips blank and incomplete lines", () => {
    expect(parseTags(`\n  \nprod/2026.11.16+1\nprod/2026.11.16+2 ${A}\n`)).toEqual([
      { tag: "prod/2026.11.16+2", sha: A },
    ]);
  });
  it("formats UTC dates", () => {
    expect(formatDate(new Date("2026-01-05T23:59:59Z"))).toBe("2026.01.05");
  });
});

describe("checkGuards", () => {
  const ok = { confirm: "promote-staging", ref: "refs/heads/main", sha: A, mainHead: A, stagingRuns: 1 };
  it("passes when everything holds", () => {
    expect(checkGuards(ok)).toEqual({ ok: true });
  });
  it("rejects a wrong confirm", () => {
    expect(checkGuards({ ...ok, confirm: "yes" }).ok).toBe(false);
  });
  it("rejects a non-main ref", () => {
    expect(checkGuards({ ...ok, ref: "refs/heads/feature" }).ok).toBe(false);
  });
  it("rejects a sha that is not the main head", () => {
    expect(checkGuards({ ...ok, sha: B }).ok).toBe(false);
  });
  it("rejects a sha without a successful staging run", () => {
    expect(checkGuards({ ...ok, stagingRuns: 0 }).ok).toBe(false);
  });
});
