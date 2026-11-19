import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/cli.ts"],
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage"
    }
  }
});
