import { afterEach, describe, expect, it } from "vitest";
import { clientPrisma, globalForPrisma } from "./client-namespace.ts";
import { Prisma } from "./generated/client.js";

describe("clientPrisma", () => {
  afterEach(() => {
    delete globalForPrisma.prismaNamespace;
  });

  it("should give the namespace the shared client was made with when one has been made", () => {
    const other = { ...Prisma } as typeof Prisma;
    globalForPrisma.prismaNamespace = other;

    expect(clientPrisma()).toBe(other);
  });

  it("should give this module's own copy when no client has been made", () => {
    expect(clientPrisma()).toBe(Prisma);
  });
});
