import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, env } from "prisma/config";
import { applyDatabaseUrl } from "./src/store/database-url.js";

// The Prisma CLI runs outside the app, so it assembles `DATABASE_URL` from the same `POSTGRES_*` parts the
// runtime client does.
applyDatabaseUrl();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: path.join(__dirname, "prisma", "schema.prisma"),
  datasource: {
    url: env("DATABASE_URL")
  }
});
