import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The suite truncates every table, so by default it gets a database of its own on the compose server rather than
// the `agent_hub` that `yarn dev` uses. An explicit `DATABASE_URL`, as the pipeline sets, is used as it is.
const INTEGRATION_DATABASE_URL = "postgresql://hmcts@localhost:5432/agent_hub_test";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/integration/server-only-stub.ts", import.meta.url)),
      // The published client's own source, so the one test that crosses the two halves of the Assistant's uploads
      // runs the pod's real parser, fetcher and envelope against the hub's real routes. An alias rather than a path
      // import because `tsconfig.json` excludes `packages` on purpose; `test/integration/pod-client.d.ts` says why
      // and declares the surface.
      "pod-client": fileURLToPath(new URL("./packages/agent-hub/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["./test/integration/setup.ts"],
    pool: "forks",
    // `--expose-gc` so the upload suite can measure what the hub *retains* while parts are in flight rather than how
    // much it allocated and threw away. Without it `heapUsed` is dominated by uncollected garbage and a reader that
    // buffered a whole file would be indistinguishable from one that holds a single part.
    execArgv: ["--expose-gc"],
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
