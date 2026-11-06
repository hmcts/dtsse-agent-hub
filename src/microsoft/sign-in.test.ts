import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteCredential = vi.hoisted(() => vi.fn());
const credentialBackend = vi.hoisted(() => vi.fn());
const credentialVersion = vi.hoisted(() => vi.fn());

vi.mock("../credentials/backend.ts", () => ({ credentialBackend }));
vi.mock("../credentials/store.ts", () => ({ credentialVersion, deleteCredential }));

const { mayCompleteMicrosoftConnect, mayConnectMicrosoft, removeRefusedMicrosoftConnection } = await import("./sign-in.ts");

const PRISMA = {} as never;
const STORE = {};
const person = (aiGateway: boolean) => ({ oid: "an-oid", tid: "a-tenant", name: "A Person", aiGateway });

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  deleteCredential.mockResolvedValue(undefined);
  credentialBackend.mockReturnValue({ available: true, store: STORE });
  credentialVersion.mockResolvedValue(new Date());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("mayConnectMicrosoft", () => {
  it("should let a connect start when the session was signed in with the AI Gateway role", () => {
    expect(mayConnectMicrosoft(person(true))).toBe(true);
  });

  it("should refuse a connect when the session was signed in without the AI Gateway role", () => {
    expect(mayConnectMicrosoft(person(false))).toBe(false);
  });
});

describe("mayCompleteMicrosoftConnect", () => {
  it("should complete the connect, logging nothing, when the person is an AI Gateway user", () => {
    expect(mayCompleteMicrosoftConnect(person(true))).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("should refuse the connect, and log why, when the person is not an AI Gateway user", () => {
    expect(mayCompleteMicrosoftConnect(person(false))).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("A Person is not an AI Gateway user"));
  });
});

describe("removeRefusedMicrosoftConnection", () => {
  it("should delete the person's connection when they sign in without the AI Gateway role", async () => {
    await removeRefusedMicrosoftConnection(PRISMA, person(false));

    expect(deleteCredential).toHaveBeenCalledWith(PRISMA, STORE, { actorOid: "an-oid", ownerOid: "an-oid", kind: "microsoft" });
  });

  it("should not look for a connection when the person signs in with the AI Gateway role", async () => {
    await removeRefusedMicrosoftConnection(PRISMA, person(true));

    expect(credentialVersion).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("should not touch the credential store when the person has no connection", async () => {
    credentialVersion.mockResolvedValue(undefined);
    await removeRefusedMicrosoftConnection(PRISMA, person(false));

    expect(credentialVersion).toHaveBeenCalledWith(PRISMA, "an-oid", "microsoft");
    expect(credentialBackend).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("should log why, without throwing, when whether the person has a connection cannot be read", async () => {
    credentialVersion.mockRejectedValue(new Error("the database is unavailable"));

    await expect(removeRefusedMicrosoftConnection(PRISMA, person(false))).resolves.toBeUndefined();
    expect(deleteCredential).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("the database is unavailable"));
  });

  it("should log why, without throwing, when the connection cannot be deleted", async () => {
    deleteCredential.mockRejectedValue(new Error("Key Vault is unavailable"));

    await expect(removeRefusedMicrosoftConnection(PRISMA, person(false))).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Key Vault is unavailable"));
  });

  it("should log why, without throwing, when the hub has no credential store to delete from", async () => {
    credentialBackend.mockReturnValue({ available: false, reason: "no credential store is configured" });

    await expect(removeRefusedMicrosoftConnection(PRISMA, person(false))).resolves.toBeUndefined();
    expect(deleteCredential).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("no credential store is configured"));
  });
});
