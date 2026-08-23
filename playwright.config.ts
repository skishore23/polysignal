import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3000",
    headless: true
  },
  webServer: {
    command: "pnpm run dev:e2e",
    env: {
      DB_PATH: "./data/e2e.db"
    },
    url: "http://localhost:3000",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI
  }
});
