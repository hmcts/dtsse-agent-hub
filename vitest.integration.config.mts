import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
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
      AUTH_DISABLED: "true"
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
