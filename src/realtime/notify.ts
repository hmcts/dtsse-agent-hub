import type { Database } from "../store/prisma.ts";
import { encodeEvent, HUB_CHANNEL, type NotifiedEvent } from "./events.ts";

/**
 * Queues a NOTIFY on the caller's connection. Called inside the transaction that wrote the row, so Postgres
 * delivers it on commit and never for a rolled-back write.
 *
 * `$executeRaw` because `pg_notify` returns `void`, which `$queryRaw` cannot deserialise.
 */
export async function notify(db: Database, event: NotifiedEvent): Promise<void> {
  await db.$executeRaw`SELECT pg_notify(${HUB_CHANNEL}, ${encodeEvent(event)})`;
}
