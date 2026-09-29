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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", ".next", "test"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "src/store/generated/**",
        "src/instrumentation.ts",
        "src/app/**",
        "src/cli/**",
        // Everything below reads or writes Postgres, and is covered by `vitest.integration.config.mts` instead.
        "src/store/**",
        "src/users/store.ts",
        "src/agents/store.ts",
        "src/agents/sweep.ts",
        "src/topics/store.ts",
        "src/messages/store.ts",
        "src/messages/feed.ts",
        "src/access/load.ts",
        "src/realtime/listener.ts",
        "src/realtime/process.ts",
        "src/realtime/notify.ts",
        "src/messages/send.ts",
        "src/agent-api/**"
      ],
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
      thresholds: {
        "src/access/**": { statements: 100, lines: 100, branches: 100, functions: 100 },
        statements: 95,
        lines: 95,
        branches: 90,
        functions: 95
      }
    }
  }
});
