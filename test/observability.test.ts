import { describe, expect, it } from "vitest";
// @ts-expect-error Vite `?raw` imports are resolved at test time.
import wranglerRaw from "../wrangler.jsonc?raw";

/** Strip JSONC comments (outside strings) and trailing commas, then parse. */
function parseJsonc(text: string): Record<string, any> {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const config = parseJsonc(wranglerRaw as string);

// Group and invite tokens appear in request URLs, so platform request logs and
// traces must stay off (issue #21).
describe("wrangler.jsonc observability is off", () => {
  const o = config.observability;
  it("disables observability, logs and traces", () => {
    expect(o).toBeDefined();
    expect(o.enabled).toBe(false);
    expect(o.logs.enabled).toBe(false);
    expect(o.logs.invocation_logs).toBe(false);
    expect(o.logs.persist).toBe(false);
    expect(o.traces.enabled).toBe(false);
    expect(o.traces.persist).toBe(false);
  });
});
