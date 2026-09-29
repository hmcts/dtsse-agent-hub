import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The suite truncates every table, so by default it gets a database of its own on the compose server rather than
// the `agent_hub` that `yarn dev` uses. An explicit `DATABASE_URL`, as the pipeline sets, is used as it is.
const INTEGRATION_DATABASE_URL = "postgresql://hmcts@localhost:5432/agent_hub_test";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/integration/server-only-stub.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["./test/integration/setup.ts"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      AGENT_AUTH_DISABLED: "true",
      AUTH_DISABLED: "true",
      DATABASE_URL: process.env.DATABASE_URL ?? INTEGRATION_DATABASE_URL
    },
    coverage: {
      // On for every run, because the pipeline invokes the script by name with no way to add `--coverage`.
      enabled: true,
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage-integration",
      include: ["src/**"],
      exclude: ["src/store/generated/**", "**/*.test.ts"]
    }
  }
});
