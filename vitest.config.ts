import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  // test-node/ runs in plain Node via vitest.node.config.ts.
  test: { include: ["test/**/*.test.ts"] },
});
