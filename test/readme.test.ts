import { describe, expect, it } from "vitest";
// @ts-expect-error Vite `?raw` imports are resolved at test time.
import mcpSource from "../src/mcp.ts?raw";
// @ts-expect-error Vite `?raw` imports are resolved at test time.
import readme from "../README.md?raw";

const source = mcpSource as string;
const readmeText = readme as string;
const toolNames = [...source.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);

describe("README documents every MCP tool", () => {
  it("finds the registered tools in src/mcp.ts", () => {
    expect(toolNames.length).toBeGreaterThan(0);
  });

  it.each(toolNames)("mentions %s", (name) => {
    expect(readmeText).toContain(`\`${name}\``);
  });
});
