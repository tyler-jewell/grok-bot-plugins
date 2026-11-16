import { describe, expect, it } from "vitest";
// @ts-expect-error Vite `?raw` imports are resolved at test time.
import mcpSource from "../src/mcp.ts?raw";
// @ts-expect-error Vite `?raw` imports are resolved at test time.
import readme from "../README.md?raw";

const source = mcpSource as string;
const readmeText = readme as string;

/** Slice the README from the `## MCP tools` heading to the next `## ` heading. */
function mcpToolsSection(text: string): string {
  const start = text.indexOf("\n## MCP tools");
  if (start === -1) return "";
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

const toolNames = [...source.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);
const registerCount = (source.match(/registerTool\(/g) ?? []).length;
const section = mcpToolsSection(readmeText);

describe("README documents every MCP tool", () => {
  it("has an `## MCP tools` section", () => {
    expect(section).toContain("## MCP tools");
  });

  it("parses a name for every registerTool( call in src/mcp.ts", () => {
    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames.length).toBe(registerCount);
  });

  it.each(toolNames)("has a table row for %s in the MCP tools section", (name) => {
    expect(section).toContain(`| \`${name}\` |`);
  });
});
