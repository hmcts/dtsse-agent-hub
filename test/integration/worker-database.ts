import { migrate } from "../../src/store/migrate.ts";
import { workerDatabase } from "./databases.ts";
import { ensureDatabase } from "./ensure-database.ts";

/**
 * Points this worker at its own database, creating it on the first run that needs it and bringing its schema up to
 * date. A setup file rather than anything in a test, because `store/prisma.ts` resolves `DATABASE_URL` at module
 * load; `migrate` is safe to import here because it reads the URL when called and never imports the Prisma client.
 *
 * This runs once per test file, so the usual cost is the migrator finding nothing to apply.
 */
const { url } = workerDatabase(process.env);
await ensureDatabase(url);
process.env.DATABASE_URL = url;
await migrate();
