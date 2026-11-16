import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("counter privacy copy", () => {
  it("says README and privacy.html keep only aggregate counters", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const privacy = readFileSync(new URL("../public/privacy.html", import.meta.url), "utf8");
    for (const text of [readme, privacy]) {
      expect(text).toMatch(/aggregate daily counters/i);
      expect(text).toMatch(/35 days/);
      expect(text).toMatch(/no tokens, group ids, names, coordinates, IP addresses, or user agents/i);
    }
  });
});
