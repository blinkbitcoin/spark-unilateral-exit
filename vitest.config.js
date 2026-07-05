import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "vendor/**", "coverage/**"],
    // Stream test console output live instead of buffering it and only
    // flushing on failure. The Spark E2E test emits [e2e ...] progress markers
    // that we want visible in CI as each phase runs, not just after a timeout.
    disableConsoleIntercept: true,
    coverage: {
      exclude: ["coverage/**", "examples/**", "test/**", "vendor/**"],
      reporter: ["text"],
    },
  },
});
