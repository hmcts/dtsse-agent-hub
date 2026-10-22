import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Suites here mutate HOME, CLAUDE_CONFIG_DIR and the working directory, and spawn detached processes, so each
    // file gets its own process rather than sharing a worker thread's globals.
    pool: "forks",
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The four barrels: each is re-exports only, so a line of any is only ever "reached" by importing it.
      exclude: ["src/__fixtures__/**", "src/index.ts", "src/assistant/index.ts", "src/stop-worker/index.ts", "src/virtual/index.ts"],
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 95,
        lines: 95,
        branches: 90,
        functions: 95
      }
    }
  }
});
