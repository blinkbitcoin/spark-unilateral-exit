import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "vendor/**", "coverage/**"],
    coverage: {
      exclude: ["coverage/**", "examples/**", "test/**", "vendor/**"],
      reporter: ["text"],
    },
  },
});
