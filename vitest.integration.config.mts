import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { stemUrl } from "./test/integration/databases.ts";

/** `migrate.test.ts` creates and drops whole databases, which is why it runs on its own; see the project below. */
const MIGRATE = "test/integration/migrate.test.ts";

const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  "server-only": fileURLToPath(new URL("./test/integration/server-only-stub.ts", import.meta.url)),
  // The published client's own source, so the one test that crosses the two halves of the Assistant's uploads
  // runs the pod's real parser, fetcher and envelope against the hub's real routes. An alias rather than a path
  // import because `tsconfig.json` excludes `packages` on purpose; `test/integration/pod-client.d.ts` says why
  // and declares the surface.
  "pod-client": fileURLToPath(new URL("./packages/agent-hub/src/index.ts", import.meta.url))
};

const shared = {
  environment: "node",
  // Before any test module, because `store/prisma.ts` resolves `DATABASE_URL` at module load.
  setupFiles: ["./test/integration/worker-database.ts"],
  pool: "forks" as const,
  // `--expose-gc` so the upload suite can measure what the hub *retains* while parts are in flight rather than how
  // much it allocated and threw away. Without it `heapUsed` is dominated by uncollected garbage and a reader that
  // buffered a whole file would be indistinguishable from one that holds a single part.
  execArgv: ["--expose-gc"],
  testTimeout: 30_000,
  env: {
    AGENT_AUTH_DISABLED: "true",
    AUTH_DISABLED: "true",
    // Resolved here, in the one process that reads the real environment, so every worker builds its name from the
    // same stem whether or not the run set `DATABASE_URL`.
    DATABASE_URL: stemUrl(process.env)
  }
};

export default defineConfig({
  test: {
    globalSetup: ["./test/integration/setup.ts"],
    projects: [
      {
        resolve: { alias },
        test: {
          ...shared,
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          exclude: ["**/node_modules/**", MIGRATE],
          // Each worker holds a Prisma pool of 10 and a listener connection, against a server whose
          // `max_connections` is the stock 100, so this is bounded by the database rather than by the cores.
          maxWorkers: Number(process.env.INTEGRATION_WORKERS ?? 6)
        }
      },
      {
        resolve: { alias },
        test: {
          ...shared,
          name: "migrations",
          include: [MIGRATE],
          // `CREATE DATABASE` and `DROP DATABASE` each force a checkpoint, which flushes every dirty page the server
          // is holding — so this file is charged for whatever else has been written to that server, by the rest of
          // this suite or by anything else sharing it. On its own it takes 3s; sharing a server with the rest of
          // this suite it has taken 80s and more. It gets a project of its own so that wait can have a timeout
          // measured against a checkpoint rather than against a route call, and one worker because dropping and
          // creating databases is server-wide rather than per database.
          maxWorkers: 1,
          testTimeout: 120_000
        }
      }
    ],
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
