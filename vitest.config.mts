import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  oxc: {
    jsx: {
      runtime: "automatic"
    }
  },
  test: {
    // Component tests opt into jsdom with a `@vitest-environment jsdom` docblock.
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
        "src/agents/views.ts",
        "src/topics/store.ts",
        "src/channels/store.ts",
        "src/messages/store.ts",
        "src/messages/feed.ts",
        "src/messages/direct-thread.ts",
        "src/access/load.ts",
        "src/access/views.ts",
        "src/realtime/listener.ts",
        "src/realtime/process.ts",
        "src/realtime/notify.ts",
        "src/messages/send.ts",
        "src/agent-api/**",
        "src/viewer/current.ts",
        "src/web/data.ts",
        "src/transcripts/store.ts",
        "src/transcripts/sweep.ts",
        "src/transcripts/views.ts"
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
