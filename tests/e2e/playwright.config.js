const { defineConfig } = require("@playwright/test");

// E2E for the AI chat. Assumes the app is already running on SF_BASE_URL
// (default http://127.0.0.1:8000). Only the chat API endpoints are intercepted
// for deterministic streaming; the rest of the app is served live.
module.exports = defineConfig({
  testDir: ".",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  reporter: [["line"]],
  use: {
    baseURL: process.env.SF_BASE_URL || "http://127.0.0.1:8000",
    headless: true,
    actionTimeout: 7_000,
  },
});
