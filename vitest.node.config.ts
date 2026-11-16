// Plain-Node project: these tests spawn scripts/next-tag.mjs with child_process,
// which the Workers pool (workerd) cannot do. Run via `npm test`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test-node/**/*.test.mjs"], environment: "node" },
});
