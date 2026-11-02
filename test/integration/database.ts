import pg from "pg";
import { resolveDatabaseUrl } from "../../src/store/database-url.ts";
import { prisma } from "../../src/store/prisma.ts";

const LEDGER = "_prisma_migrations";

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders the tables so each comes after every table that references it through a foreign key refusing the delete
 * (`NO ACTION` or `RESTRICT`). Keys that cascade or set null need no order, and they are where the schema's cycles
 * are, so a cycle here is a schema this reset cannot empty and is an error.
 */
export function deleteOrder(tables: readonly string[], blocking: readonly { child: string; parent: string }[]): string[] {
  const children = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const { child, parent } of blocking) {
    if (child !== parent) {
      children.get(parent)?.add(child);
    }
  }
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(table: string): void {
    if (done.has(table)) {
      return;
    }
    if (visiting.has(table)) {
      throw new Error(`the foreign keys that refuse a delete form a cycle through ${table}`);
    }
    visiting.add(table);
    for (const child of [...(children.get(table) ?? [])].sort(byCodePoint)) {
      visit(child);
    }
    visiting.delete(table);
    done.add(table);
    ordered.push(table);
  }
  for (const table of [...tables].sort(byCodePoint)) {
    visit(table);
  }
  return ordered;
}

/**
 * One `DO` block that empties every table and restarts every sequence, built from the catalogue once per test file.
 *
 * `DELETE` rather than `TRUNCATE`: a truncate swaps in new files for every table, index and TOAST table whether
 * or not it held a row, which costs about a quarter of a second per reset, while a delete of a table a test never
 * touched costs nothing. The `ACCESS EXCLUSIVE` lock first is the one `TRUNCATE` takes, so the reset still waits
 * for any transaction a previous test left running and then removes what it wrote, rather than leaving it behind.
 * Nothing here fires a `NOTIFY`: the schema's only trigger is the topic-count check, and `notify` is called by
 * the application, never by a trigger.
 */
async function buildReset(): Promise<string> {
  const tables = (
    await prisma.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relname <> ${LEDGER}`
  ).map(({ name }) => name);
  const blocking = await prisma.$queryRaw<{ child: string; parent: string }[]>`
    SELECT child.relname AS child, parent.relname AS parent FROM pg_constraint k
    JOIN pg_class child ON child.oid = k.conrelid
    JOIN pg_class parent ON parent.oid = k.confrelid
    WHERE k.contype = 'f' AND k.confdeltype IN ('a', 'r') AND child.relnamespace = 'public'::regnamespace`;
  const sequences = (await prisma.$queryRaw<{ name: string }[]>`SELECT sequencename AS name FROM pg_sequences WHERE schemaname = 'public'`).map(
    ({ name }) => name
  );
  const statements = [
    `LOCK TABLE ${[...tables].sort(byCodePoint).map(quoted).join(", ")} IN ACCESS EXCLUSIVE MODE;`,
    ...deleteOrder(tables, blocking).map((table) => `DELETE FROM ${quoted(table)};`),
    ...[...sequences].sort(byCodePoint).map((sequence) => `PERFORM setval('${quoted(sequence).replaceAll("'", "''")}', 1, false);`)
  ];
  return `DO $reset$ BEGIN ${statements.join(" ")} END $reset$`;
}

let reset: Promise<string> | undefined;

/** Empties every table the schema defines and restarts its sequences, leaving the migration ledger alone. */
export async function resetDatabase(): Promise<void> {
  reset ??= buildReset();
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
