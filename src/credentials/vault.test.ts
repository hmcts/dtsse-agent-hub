import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  setSecret: vi.fn(),
  getSecret: vi.fn(),
  beginDeleteSecret: vi.fn(),
  beginRecoverDeletedSecret: vi.fn()
}));
const constructed = vi.hoisted(() => vi.fn());
const defaultCredential = vi.hoisted(() => vi.fn());

vi.mock("@azure/keyvault-secrets", () => ({
  SecretClient: function SecretClient(url: string, credential: unknown) {
    constructed(url, credential);
    return client;
  }
}));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: function DefaultAzureCredential() {
    defaultCredential();
    return { getToken: async () => null };
  }
}));

const { createVaultStore } = await import("./vault.ts");

const URL = "https://dtsse-ah-creds-aat.vault.azure.net/";
const NAME = "u-0f8a3c1e-1b2d-4e5f-8a9b-0c1d2e3f4a5b-github";
const TAGS = { owner: "0f8a3c1e-1b2d-4e5f-8a9b-0c1d2e3f4a5b", kind: "github", via: "web" };

function restError(statusCode: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), { statusCode, ...(code === undefined ? {} : { code }) });
}

function poller(result: unknown = {}) {
  return { pollUntilDone: vi.fn(async () => result) };
}

const DELETED = () => restError(409, `Secret ${NAME} is currently in a deleted but recoverable state, and its name cannot be reused`, "Conflict");
const DELETING = () => restError(409, `Secret ${NAME} is currently being deleted.`, "Conflict");

function store() {
  return createVaultStore({ url: URL, credential: { getToken: async () => null }, pauseMs: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  client.setSecret.mockReset().mockResolvedValue({});
  client.getSecret.mockReset();
  client.beginDeleteSecret.mockReset().mockResolvedValue(poller());
  client.beginRecoverDeletedSecret.mockReset().mockResolvedValue(poller());
});

describe("createVaultStore", () => {
  it("should talk to the configured vault with the credential it was given when constructed", () => {
    const credential = { getToken: async () => null };

    createVaultStore({ url: URL, credential });

    expect(constructed).toHaveBeenCalledWith(URL, credential);
    expect(defaultCredential).not.toHaveBeenCalled();
  });

  it("should fall back to the default Azure credential when none is given, which finds the workload identity", () => {
    createVaultStore({ url: URL });

    expect(defaultCredential).toHaveBeenCalledOnce();
  });

  it("should never accept development identities when it is the real vault", () => {
    expect(store().acceptsDevIdentities).toBe(false);
  });
});

describe("put", () => {
  it("should set the secret with its tags when the name is free", async () => {
    await store().put(NAME, "a-value", TAGS);

    expect(client.setSecret).toHaveBeenCalledWith(NAME, "a-value", { tags: TAGS, contentType: "text/plain" });
    expect(client.beginRecoverDeletedSecret).not.toHaveBeenCalled();
  });

  it("should recover a soft-deleted secret and then set it when the name is held by a deleted one", async () => {
    const recovered = poller();
    client.beginRecoverDeletedSecret.mockResolvedValue(recovered);
    client.setSecret.mockRejectedValueOnce(DELETED()).mockResolvedValueOnce({});

    await store().put(NAME, "a-value", TAGS);

    expect(client.beginRecoverDeletedSecret).toHaveBeenCalledWith(NAME);
    expect(recovered.pollUntilDone).toHaveBeenCalled();
    expect(client.setSecret).toHaveBeenCalledTimes(2);
    expect(client.setSecret).toHaveBeenLastCalledWith(NAME, "a-value", { tags: TAGS, contentType: "text/plain" });
    expect(recovered.pollUntilDone.mock.invocationCallOrder[0]).toBeLessThan(client.setSecret.mock.invocationCallOrder[1]!);
  });

  it("should recognise the inner error code as well when the service reports it", async () => {
    client.setSecret.mockRejectedValueOnce(restError(409, "conflict", "ObjectIsDeletedButRecoverable")).mockResolvedValueOnce({});

    await store().put(NAME, "a-value", TAGS);

    expect(client.beginRecoverDeletedSecret).toHaveBeenCalledOnce();
  });

  it("should wait and retry without recovering when a deletion of the name is still finishing", async () => {
    client.setSecret.mockRejectedValueOnce(DELETING()).mockRejectedValueOnce(DELETED()).mockResolvedValueOnce({});

    await store().put(NAME, "a-value", TAGS);

    expect(client.setSecret).toHaveBeenCalledTimes(3);
    expect(client.beginRecoverDeletedSecret).toHaveBeenCalledOnce();
  });

  it("should give up with the vault's error when the name stays in conflict", async () => {
    client.setSecret.mockRejectedValue(DELETING());

    await expect(store().put(NAME, "a-value", TAGS)).rejects.toThrow("being deleted");
    expect(client.setSecret).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["a 403", restError(403, "Caller is not authorized", "Forbidden")],
    ["a 409 of another kind", restError(409, "something else conflicted", "Conflict")],
    ["an error with no status", new Error("socket hang up")],
    ["something that is not an error", null]
  ])("should pass %s straight up when setting fails", async (_label, error) => {
    client.setSecret.mockRejectedValue(error);

    await expect(store().put(NAME, "a-value", TAGS)).rejects.toBe(error);
    expect(client.setSecret).toHaveBeenCalledOnce();
    expect(client.beginRecoverDeletedSecret).not.toHaveBeenCalled();
  });

  it("should pause between attempts when told how long to wait", async () => {
    vi.useFakeTimers();
    try {
      client.setSecret.mockRejectedValueOnce(DELETING()).mockResolvedValueOnce({});
      const putting = createVaultStore({ url: URL, credential: { getToken: async () => null }, pauseMs: 1_000 }).put(NAME, "v", TAGS);

      await vi.advanceTimersByTimeAsync(999);
      expect(client.setSecret).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await putting;
      expect(client.setSecret).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("get", () => {
  it("should return the value when the secret exists", async () => {
    client.getSecret.mockResolvedValue({ name: NAME, value: "a-value" });

    expect(await store().get(NAME)).toBe("a-value");
  });

  it("should return nothing when the secret does not exist", async () => {
    client.getSecret.mockRejectedValue(restError(404, "SecretNotFound"));

    expect(await store().get(NAME)).toBeUndefined();
  });

  it("should pass any other failure up when reading fails", async () => {
    client.getSecret.mockRejectedValue(restError(403, "Forbidden"));

    await expect(store().get(NAME)).rejects.toThrow("Forbidden");
  });
});

describe("remove", () => {
  it("should soft-delete the secret and wait for the deletion when it exists, never purging", async () => {
    const deleting = poller();
    client.beginDeleteSecret.mockResolvedValue(deleting);

    await store().remove(NAME);

    expect(client.beginDeleteSecret).toHaveBeenCalledWith(NAME);
    expect(deleting.pollUntilDone).toHaveBeenCalled();
    expect(client).not.toHaveProperty("purgeDeletedSecret");
  });

  it("should succeed when there is no such secret", async () => {
    client.beginDeleteSecret.mockRejectedValue(restError(404, "SecretNotFound"));

    await expect(store().remove(NAME)).resolves.toBeUndefined();
  });

  it("should pass any other failure up when deleting fails", async () => {
    client.beginDeleteSecret.mockRejectedValue(restError(500, "InternalServerError"));

    await expect(store().remove(NAME)).rejects.toThrow("InternalServerError");
  });
});
