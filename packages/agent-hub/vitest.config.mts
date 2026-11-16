import { configDefaults, defineConfig } from "vitest/config";

// Each case of these runs bash and node against wall-clock watchdogs, so more than two at once on a small agent
// starves them past their deadlines. `maxConcurrency` applies per project, hence a project of their own.
const SHELL_SUITES = ["src/virtual-agent-boot.test.ts", "src/virtual-agent-entrypoint.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    // Suites here mutate HOME, CLAUDE_CONFIG_DIR and the working directory, and spawn detached processes, so each
    // file gets its own process rather than sharing a worker thread's globals.
    pool: "forks",
    testTimeout: 30_000,
    projects: [
      { extends: true, test: { name: "unit", include: ["src/**/*.test.ts"], exclude: [...configDefaults.exclude, ...SHELL_SUITES] } },
      { extends: true, test: { name: "shell", include: SHELL_SUITES, maxConcurrency: 2 } }
    ],
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
