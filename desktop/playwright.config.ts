import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./ui", workers: 1, fullyParallel: false, timeout: 120_000,
  expect: { timeout: 15_000 }, reporter: "list",
  use: { trace: "off", screenshot: "off", video: "off" },
});
