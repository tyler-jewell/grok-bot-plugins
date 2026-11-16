import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("turnstile is not configured with a committed secret", () => {
  it("does not put TURNSTILE_SECRET in wrangler vars", () => {
    const wrangler = readFileSync(new URL("wrangler.jsonc", root), "utf8");
    expect(wrangler).not.toContain("TURNSTILE_SECRET");
  });

  it("says MCP create_group is not challenged", () => {
    const readme = readFileSync(new URL("README.md", root), "utf8");
    expect(readme).toContain("MCP `create_group` is not challenged");
    const privacy = readFileSync(new URL("public/privacy.html", root), "utf8");
    expect(privacy).toContain("do not use Turnstile");
  });
});
