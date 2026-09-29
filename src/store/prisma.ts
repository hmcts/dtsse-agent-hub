import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { applyDatabaseUrl } from "./database-url.ts";
import { PrismaClient } from "./generated/client.js";

/**
 * Resolved at module load, which is why `instrumentation.ts` and `cli/migrate.ts` import this only after the Key
 * Vault secrets have been loaded: the chart mounts `POSTGRES_*` as files, and they exist as variables only once
 * `getPropertiesVolumeSecrets` has run.
 */
const connectionString = applyDatabaseUrl();

const POOL = {
  max: 10,
  idleTimeoutMillis: 30_000,
  // Makes an exhausted pool fail rather than hang.
  connectionTimeoutMillis: 10_000,
  application_name: "dtsse-agent-hub"
} as const;

const TRANSACTION = {
  timeout: 15_000,
  // The same as the pool's own checkout timeout, so an exhausted pool fails on one timer rather than two.
  maxWait: 10_000
} as const;

/**
 * On `globalThis` in every environment. Next bundles `instrumentation.ts` and the route modules as separate module
 * graphs, so a module-scoped client would be one pool per graph per pod.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

globalForPrisma.prisma ??= new PrismaClient({
  adapter: new PrismaPg(new pg.Pool({ connectionString, ...POOL })),
  transactionOptions: TRANSACTION,
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});

export const prisma: PrismaClient = globalForPrisma.prisma;

export type { Prisma, PrismaClient } from "./generated/client.js";

/** What a function that may run inside or outside a transaction accepts. */
export type Database = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;
