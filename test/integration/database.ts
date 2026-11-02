import pg from "pg";
import { resolveDatabaseUrl } from "../../src/store/database-url.ts";
import { prisma } from "../../src/store/prisma.ts";
import { byCodePoint } from "../../src/topics/slug.ts";

const LEDGER = "_prisma_migrations";

export function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The schema's own tables, read from the catalogue so a table a migration adds is emptied without being listed. */
export async function schemaTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname <> ${LEDGER}`;
  return rows.map(({ name }) => name).sort(byCodePoint);
}

/**
 * One `DO` block that empties every table and restarts every sequence at its own start value, built from the
 * catalogue as it stands when called.
 *
 * `DELETE` rather than `TRUNCATE`: a truncate swaps in new files for every table, index and TOAST table whether
 * or not it held a row, which costs about a quarter of a second per reset, while a delete of a table a test never
 * touched costs nothing. The `ACCESS EXCLUSIVE` lock first is the one `TRUNCATE` takes, so the reset still waits
 * for any transaction a previous test left running and then removes what it wrote, rather than leaving it behind.
 *
 * `session_replication_role = replica`, local to the block, turns off the foreign-key triggers and every other
 * trigger, so the deletes need no order: the schema's keys form cycles, and a cascade can empty a parent before a
 * table that refuses that delete, so no order is safe in general. Every table is deleted from explicitly, so nothing
 * relies on a cascade. Setting it needs a superuser, which the compose server's and the pipeline's `hmcts` both are.
 * With the triggers off nothing here can fire a `NOTIFY`.
 */
export async function resetStatement(): Promise<string> {
  const tables = await schemaTables();
  const sequences = await prisma.$queryRaw<{ name: string; start: bigint }[]>`
    SELECT sequencename AS name, start_value AS start FROM pg_sequences WHERE schemaname = 'public'`;
  const statements = [
    "PERFORM set_config('session_replication_role', 'replica', true);",
    `LOCK TABLE ${tables.map(quoted).join(", ")} IN ACCESS EXCLUSIVE MODE;`,
    ...tables.map((table) => `DELETE FROM ${quoted(table)};`),
    ...sequences
      .sort((left, right) => byCodePoint(left.name, right.name))
      .map(({ name, start }) => `PERFORM setval('${quoted(name).replaceAll("'", "''")}', ${start}, false);`)
  ];
  return `DO $reset$ BEGIN ${statements.join(" ")} END $reset$`;
}

let reset: Promise<string> | undefined;

/** Empties every table the schema defines and restarts its sequences, leaving the migration ledger alone. */
export async function resetDatabase(): Promise<void> {
  reset ??= resetStatement().catch((error: unknown) => {
    reset = undefined;
    throw error;
  });
  await prisma.$executeRawUnsafe(await reset);
}

/** A connection of its own, for tests that need to hold a transaction or a lock open. */
export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  return client;
}

export interface Person {
  oid: string;
  name: string;
  email: string;
}

export function person(handle: string): Person {
  return { oid: `dev-${handle}`, name: `${handle[0]!.toUpperCase()}${handle.slice(1)} Tester`, email: `${handle}@example.com` };
}

export function devUser(who: Person): string {
  return `${who.oid}|${who.name}|${who.email}`;
}

export async function insertUser(who: Person): Promise<void> {
  await prisma.user.upsert({ where: { oid: who.oid }, create: { oid: who.oid, tid: "dev", name: who.name, email: who.email }, update: {} });
}

export async function insertAgent(
  who: Person,
  name: string,
  overrides: { status?: "busy" | "idle" | "offline"; lastHeartbeatAt?: Date; repo?: string; branch?: string } = {}
): Promise<string> {
  await insertUser(who);
  const agent = await prisma.agent.create({
    data: {
      ownerOid: who.oid,
      sessionId: `${who.oid}-${name}-${Math.random().toString(36).slice(2)}`,
      name,
      status: overrides.status ?? "idle",
      repo: overrides.repo ?? null,
      branch: overrides.branch ?? null,
      ...(overrides.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: overrides.lastHeartbeatAt })
    },
    select: { id: true }
  });
  return agent.id;
}

export { prisma };

/**
 * Marks the person as having connected GitHub, Azure and both model keys, which is everything `chatGate` reads on any
 * route, so a suite about something else can drive the Assistant's actions. Azure is among them because it is the
 * model credential on the `gateway` route, which is where a persona whose name says nothing about a route lands.
 * Rows only: the gate never reads a value.
 */
export async function connectForChat(who: Person): Promise<void> {
  await insertUser(who);
  await prisma.credential.createMany({
    data: (["github", "azure", "claude", "jenkins"] as const).map((kind) => ({
      ownerOid: who.oid,
      kind,
      secretName: `u-${who.oid}-${kind}`,
      updatedVia: "web" as const
    })),
    skipDuplicates: true
  });
}
