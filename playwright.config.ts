import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3167",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "npm run e2e:server",
      url: "http://127.0.0.1:43117/api/health",
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: "HARLAN_API_URL=http://127.0.0.1:43117 npm run dev:web",
      url: "http://127.0.0.1:3167",
      reuseExistingServer: false,
      timeout: 20_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
