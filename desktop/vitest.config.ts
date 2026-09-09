import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["test/desktop/**/*.test.ts"],
  coverage: { provider: "v8", include: ["desktop/**/*.ts", "src/transaction-id.ts"], exclude: ["desktop/**/*.config.ts", "desktop/ui/**"],
    reportsDirectory: "coverage/desktop", reporter: ["text", "json", "html"],
    thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 } },
} });
