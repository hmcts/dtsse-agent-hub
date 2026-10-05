import pg from "pg";
import { resolveDatabaseUrl } from "../../src/store/database-url.ts";
import { prisma } from "../../src/store/prisma.ts";

/** Empties every table the schema defines, leaving the migration ledger alone. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "dev_credential_value", "credential", "transcript_entry", "delivery", "subscription", "message_topic", "message", "topic", "channel", "agent_grant", "agent", "user" RESTART IDENTITY CASCADE`
  );
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
