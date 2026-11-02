import { Prisma } from "./generated/client.js";

/**
 * Where `store/prisma.ts` keeps the `Prisma` namespace of the copy of the generated client that made the shared client.
 * Also read by that module, which sets it.
 */
export const globalForPrisma = globalThis as unknown as { prismaNamespace?: typeof Prisma };

/**
 * The `Prisma` namespace to build SQL fragments and null sentinels with: the one belonging to the client that will run
 * them. Next bundles `instrumentation.ts` and the route modules as separate module graphs, each with its own copy of
 * the generated client, and the shared client on `globalThis` is whichever graph made it first. It recognises a
 * `Prisma.sql` fragment or `Prisma.DbNull` only from its own copy; one from the other copy is sent as a bound
 * parameter instead, as `{"values":[],"strings":[…]}`. Read at call time, so it is the client's own once one exists.
 */
export function clientPrisma(): typeof Prisma {
  return globalForPrisma.prismaNamespace ?? Prisma;
}
