import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The barrel, and the CLI entry, which cli.test.ts drives as a child process that v8 coverage does not see.
      exclude: ["src/__fixtures__/**", "src/index.ts", "src/cli.ts"],
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 94,
        lines: 94,
        branches: 84,
        functions: 95
      }
    }
  }
});
