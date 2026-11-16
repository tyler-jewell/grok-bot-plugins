import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = new URL("../scripts/assert-no-uncaught.mjs", import.meta.url).pathname;

function run(text) {
  const dir = mkdtempSync(join(tmpdir(), "uncaught-"));
  const log = join(dir, "test.log");
  writeFileSync(log, text);
  return spawnSync(process.execPath, [script, log], { encoding: "utf8" });
}

describe("assert-no-uncaught", () => {
  it("exits 0 when the log has no uncaught exception", () => {
    const result = run("Tests  77 passed\n");
    expect(result.status).toBe(0);
  });

  it("exits 1 when the log contains an uncaught exception", () => {
    const result = run("uncaught exception; source = Uncaught (in promise)\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/uncaught exception in test output/);
  });
});
