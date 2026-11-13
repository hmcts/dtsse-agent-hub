import { type BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeedbackBlobs, feedbackBlobs, projectPrefix, READ_TTL_MS, recordingPrefix, segmentPath, snapshotPath, UPLOAD_TTL_MS } from "./blob.ts";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const RECORDING = "22222222-2222-4222-8222-222222222222";
const THREAD = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-13T12:00:00Z");
const BASE = "https://account.blob.core.windows.net/feedback";

function fakeService(credential: unknown, blobs: string[] = []) {
  const uploadData = vi.fn(async () => ({}));
  const deleteIfExists = vi.fn(async (_options: unknown) => ({}));
  const container = {
    createIfNotExists: vi.fn(async () => ({})),
    getBlockBlobClient: (path: string) => ({ url: `${BASE}/${path}`, uploadData }),
    listBlobsFlat: vi.fn(({ prefix }: { prefix: string }) =>
      (async function* () {
        for (const name of blobs.filter((blob) => blob.startsWith(prefix))) {
          yield { name };
        }
      })()
    ),
    deleteBlob: vi.fn(async (_name: string, _options: unknown) => ({})),
    getBlobClient: vi.fn((path: string) => ({ path, deleteIfExists }))
  };
  const service = {
    credential,
    accountName: "account",
    getContainerClient: vi.fn(() => container),
    setProperties: vi.fn(async () => ({})),
    getUserDelegationKey: vi.fn(async (startsOn: Date, expiresOn: Date) => ({
      signedObjectId: "oid",
      signedTenantId: "tid",
      signedStartsOn: startsOn,
      signedExpiresOn: expiresOn,
      signedService: "b",
      signedVersion: "2025-01-05",
      value: Buffer.from("k".repeat(32)).toString("base64")
    }))
  };
  return { service, container, uploadData, deleteIfExists, typed: service as unknown as BlobServiceClient };
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

const IDENTITY = { kind: "identity", accountUrl: "https://account.blob.core.windows.net", container: "feedback" } as const;
const CONNECTION = { kind: "connection", connectionString: "UseDevelopmentStorage=true", container: "feedback" } as const;
const SHARED_KEY = new StorageSharedKeyCredential("account", Buffer.from("devkey").toString("base64"));

describe("blob paths", () => {
  it("should put everything of a project under its id", () => {
    expect(projectPrefix(PROJECT)).toBe(`${PROJECT}/`);
    expect(snapshotPath(PROJECT, THREAD)).toBe(`${PROJECT}/snapshots/${THREAD}.json.gz`);
    expect(recordingPrefix(PROJECT, RECORDING)).toBe(`${PROJECT}/recordings/${RECORDING}/`);
    expect(segmentPath(PROJECT, RECORDING, "audio", 7)).toBe(`${PROJECT}/recordings/${RECORDING}/audio/0007`);
    expect(segmentPath(PROJECT, RECORDING, "replay", 9999)).toBe(`${PROJECT}/recordings/${RECORDING}/replay/9999`);
  });

  it("should keep every path under the project's and the recording's prefixes", () => {
    expect(snapshotPath(PROJECT, THREAD).startsWith(projectPrefix(PROJECT))).toBe(true);
    expect(segmentPath(PROJECT, RECORDING, "audio", 0).startsWith(recordingPrefix(PROJECT, RECORDING))).toBe(true);
  });
});

describe("createFeedbackBlobs", () => {
  it("should sign a write-only https upload URL from a user delegation key when the account is reached by identity", async () => {
    const { service, typed } = fakeService({});
    const blobs = createFeedbackBlobs(IDENTITY, { service: typed, now: () => NOW });

    const url = await blobs.uploadUrl("p/a");
    const query = queryOf(url);

    expect(url.startsWith(`${BASE}/p/a?`)).toBe(true);
    expect(query.get("sp")).toBe("cw");
    expect(query.get("spr")).toBe("https");
    expect(query.get("skoid")).toBe("oid");
    expect(query.get("se")).toBe(new Date(NOW.getTime() + UPLOAD_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(service.setProperties).not.toHaveBeenCalled();
  });

  it("should reuse one delegation key while it outlives the SAS, and ask for another when it would not", async () => {
    let now = NOW;
    const { service, typed } = fakeService({});
    const blobs = createFeedbackBlobs(IDENTITY, { service: typed, now: () => now });

    await blobs.readUrl("p/a");
    await blobs.readUrl("p/b");
    now = new Date(NOW.getTime() + 90 * 60_000);
    await blobs.readUrl("p/c");

    expect(service.getUserDelegationKey).toHaveBeenCalledTimes(2);
  });

  it("should ask for a key again after asking for one failed", async () => {
    const { service, typed } = fakeService({});
    service.getUserDelegationKey.mockRejectedValueOnce(new Error("403"));
    const blobs = createFeedbackBlobs(IDENTITY, { service: typed, now: () => NOW });

    await expect(blobs.readUrl("p/a")).rejects.toThrow("403");
    const url = await blobs.readUrl("p/a");

    expect(queryOf(url).get("sp")).toBe("r");
    expect(service.getUserDelegationKey).toHaveBeenCalledTimes(2);
  });

  it("should sign with the account key, make the container and open CORS once when it is Azurite", async () => {
    const { service, container, typed } = fakeService(SHARED_KEY);
    const blobs = createFeedbackBlobs(CONNECTION, { service: typed, now: () => NOW });

    const url = await blobs.readUrl("p/a");
    await blobs.uploadUrl("p/b", 1000);

    expect(queryOf(url).get("sp")).toBe("r");
    expect(queryOf(url).get("spr")).toBe("https,http");
    expect(queryOf(url).get("se")).toBe(new Date(NOW.getTime() + READ_TTL_MS).toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(queryOf(url).get("skoid")).toBeNull();
    expect(container.createIfNotExists).toHaveBeenCalledTimes(1);
    expect(service.setProperties).toHaveBeenCalledTimes(1);
    expect(service.getUserDelegationKey).not.toHaveBeenCalled();
  });

  it("should try making the container again after it failed", async () => {
    const { container, typed } = fakeService(SHARED_KEY);
    container.createIfNotExists.mockRejectedValueOnce(new Error("down"));
    const blobs = createFeedbackBlobs(CONNECTION, { service: typed, now: () => NOW });

    await expect(blobs.readUrl("p/a")).rejects.toThrow("down");
    await blobs.readUrl("p/a");

    expect(container.createIfNotExists).toHaveBeenCalledTimes(2);
  });

  it("should write a blob with its content type", async () => {
    const { uploadData, typed } = fakeService({});
    const blobs = createFeedbackBlobs(IDENTITY, { service: typed });

    await blobs.putBlob("p/a", new Uint8Array([1, 2]), "application/gzip");

    expect(uploadData).toHaveBeenCalledWith(new Uint8Array([1, 2]), { blobHTTPHeaders: { blobContentType: "application/gzip" } });
  });

  it("should delete one blob and its snapshots, answering nothing when it is not there", async () => {
    const { container, deleteIfExists, typed } = fakeService({});
    const blobs = createFeedbackBlobs(IDENTITY, { service: typed });

    await blobs.deleteBlob("p/snapshots/t.json.gz");

    expect(container.getBlobClient).toHaveBeenCalledWith("p/snapshots/t.json.gz");
    expect(deleteIfExists).toHaveBeenCalledWith({ deleteSnapshots: "include" });
  });

  it("should delete every blob under a prefix and nothing beside it", async () => {
    const { container, typed } = fakeService({}, [`${PROJECT}/a`, `${PROJECT}/b/c`, "other/a"]);
    const blobs = createFeedbackBlobs(IDENTITY, { service: typed });

    expect(await blobs.deletePrefix(projectPrefix(PROJECT))).toBe(2);
    expect(container.deleteBlob.mock.calls.map(([name]) => name)).toEqual([`${PROJECT}/a`, `${PROJECT}/b/c`]);
  });

  it.each([[""], [PROJECT]])("should refuse to delete under %j, which is not a folder", async (prefix) => {
    const { container, typed } = fakeService({}, ["x"]);
    const blobs = createFeedbackBlobs(IDENTITY, { service: typed });

    await expect(blobs.deletePrefix(prefix)).rejects.toThrow("ends with /");
    expect(container.listBlobsFlat).not.toHaveBeenCalled();
  });

  it("should build a real client from the settings when none is given", async () => {
    const blobs = createFeedbackBlobs(IDENTITY, { credential: { getToken: async () => null } });

    expect(typeof blobs.uploadUrl).toBe("function");
  });
});

describe("feedbackBlobs", () => {
  afterEach(() => {
    delete (globalThis as { agentHubFeedbackBlobs?: unknown }).agentHubFeedbackBlobs;
  });

  it("should answer none when there is no storage", () => {
    expect(feedbackBlobs({})).toBeUndefined();
  });

  it("should keep one client for the same settings and make another when they change", () => {
    const first = feedbackBlobs({ FEEDBACK_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true" });

    expect(feedbackBlobs({ FEEDBACK_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true" })).toBe(first);
    expect(feedbackBlobs({ FEEDBACK_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true", FEEDBACK_STORAGE_CONTAINER: "other" })).not.toBe(first);
  });
});
