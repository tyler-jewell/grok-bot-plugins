import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test-a11y",
  timeout: 30_000,
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:4173" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/static-preview.mjs",
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: false,
  },
});
