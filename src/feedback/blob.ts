import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import {
  BlobSASPermissions,
  BlobServiceClient,
  type ContainerClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
  type UserDelegationKey
} from "@azure/storage-blob";
import { type FeedbackBlobSettings, feedbackBlobSettings } from "./settings.ts";

/**
 * Where a feedback project's bytes are: page snapshots and recording segments, all under the project's id so that
 * deleting a project, or one recording, is deleting a prefix. The browser puts and gets them directly, by SAS, so the
 * hub never streams a recording; it only signs.
 *
 * Deployed, the account has no keys (`shared_access_key_enabled = false` in `infrastructure/storage.tf`): the hub's
 * managed identity asks for a user delegation key and signs with that, so a SAS is only ever as good as the identity's
 * own role, and revoking the role revokes every SAS. Locally Azurite has only its well-known account key, which signs
 * a service SAS for the one blob.
 */

export type SegmentKind = "audio" | "replay";

export interface FeedbackBlobs {
  /** A write-only URL for one blob: the browser may create it and write it, and nothing else. */
  uploadUrl: (path: string, ttlMs?: number) => Promise<string>;
  /** A read-only URL for one blob, for the player and the snapshot view. */
  readUrl: (path: string, ttlMs?: number) => Promise<string>;
  /** Writes one blob from the hub itself. */
  putBlob: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  /** Deletes each blob that is there, and answers the paths that could not be deleted; one already gone is deleted. */
  deleteBlobs: (paths: readonly string[]) => Promise<string[]>;
  /** Deletes every blob under `prefix` and answers how many there were, or throws when any could not be deleted. */
  deletePrefix: (prefix: string) => Promise<number>;
}

/** Long enough to put one 10-second segment over a slow connection; the shell asks again for the next. */
export const UPLOAD_TTL_MS = 5 * 60_000;
/** Long enough to play a long recording through without the player asking again. */
export const READ_TTL_MS = 30 * 60_000;
/** A SAS starts this far back, so a browser whose clock runs behind Azure's can still use it at once. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** How long one user delegation key is asked for. Azure allows up to 7 days. */
const DELEGATION_KEY_MS = 2 * 60 * 60_000;
/** A SAS may not outlive the key that signed it, so a cached key is replaced once it would expire this soon after one. */
const DELEGATION_KEY_MARGIN_MS = 5 * 60_000;

export function projectPrefix(projectId: string): string {
  return `${projectId}/`;
}

export function snapshotPath(projectId: string, threadId: string): string {
  return `${projectId}/snapshots/${threadId}.json.gz`;
}

export function recordingPrefix(projectId: string, recordingId: string): string {
  return `${projectId}/recordings/${recordingId}/`;
}

/** Zero-padded, so a listing of a recording's segments is in the order they were recorded. */
export function segmentPath(projectId: string, recordingId: string, kind: SegmentKind, seq: number): string {
  return `${recordingPrefix(projectId, recordingId)}${kind}/${String(seq).padStart(4, "0")}`;
}

export interface FeedbackBlobOptions {
  /** The service client; built from `settings` when not given, which is what tests replace. */
  service?: BlobServiceClient;
  credential?: TokenCredential;
  now?: () => Date;
}

type Signer = (expiresOn: Date) => Promise<StorageSharedKeyCredential | { key: UserDelegationKey; accountName: string }>;

function serviceFor(settings: FeedbackBlobSettings, credential: TokenCredential | undefined): BlobServiceClient {
  return settings.kind === "connection"
    ? BlobServiceClient.fromConnectionString(settings.connectionString)
    : new BlobServiceClient(settings.accountUrl, credential ?? new DefaultAzureCredential());
}

export function createFeedbackBlobs(settings: FeedbackBlobSettings, options: FeedbackBlobOptions = {}): FeedbackBlobs {
  const now = options.now ?? (() => new Date());
  const service = options.service ?? serviceFor(settings, options.credential);
  const container = service.getContainerClient(settings.container);
  let delegation: Promise<UserDelegationKey> | undefined;
  let delegationExpires = 0;
  let ensured: Promise<void> | undefined;

  const signer: Signer = async (expiresOn) => {
    if (service.credential instanceof StorageSharedKeyCredential) {
      return service.credential;
    }
    if (delegation === undefined || delegationExpires < expiresOn.getTime() + DELEGATION_KEY_MARGIN_MS) {
      const startsOn = new Date(now().getTime() - CLOCK_SKEW_MS);
      const keyExpires = new Date(now().getTime() + DELEGATION_KEY_MS);
      delegationExpires = keyExpires.getTime();
      delegation = service.getUserDelegationKey(startsOn, keyExpires).catch((error: unknown) => {
        delegation = undefined;
        throw error;
      });
    }
    return { key: await delegation, accountName: service.accountName };
  };

  // Azurite starts empty and answers no browser without CORS, where the deployed account has both from Terraform.
  const ready = (): Promise<void> => {
    if (settings.kind !== "connection") {
      return Promise.resolve();
    }
    ensured ??= (async () => {
      await container.createIfNotExists();
      await service.setProperties({
        cors: [{ allowedOrigins: "*", allowedMethods: "GET,HEAD,PUT", allowedHeaders: "*", exposedHeaders: "*", maxAgeInSeconds: 3600 }]
      });
    })().catch((error: unknown) => {
      ensured = undefined;
      throw error;
    });
    return ensured;
  };

  const sign = async (path: string, permissions: string, ttlMs: number): Promise<string> => {
    await ready();
    const startsOn = new Date(now().getTime() - CLOCK_SKEW_MS);
    const expiresOn = new Date(now().getTime() + ttlMs);
    const values = {
      containerName: settings.container,
      blobName: path,
      permissions: BlobSASPermissions.parse(permissions),
      startsOn,
      expiresOn,
      protocol: settings.kind === "connection" ? SASProtocol.HttpsAndHttp : SASProtocol.Https
    };
    const credential = await signer(expiresOn);
    const query =
      credential instanceof StorageSharedKeyCredential
        ? generateBlobSASQueryParameters(values, credential)
        : generateBlobSASQueryParameters(values, credential.key, credential.accountName);
    return `${container.getBlockBlobClient(path).url}?${query.toString()}`;
  };

  return {
    uploadUrl: (path, ttlMs = UPLOAD_TTL_MS) => sign(path, "cw", ttlMs),
    readUrl: (path, ttlMs = READ_TTL_MS) => sign(path, "r", ttlMs),
    putBlob: async (path, bytes, contentType) => {
      await ready();
      await container.getBlockBlobClient(path).uploadData(bytes, { blobHTTPHeaders: { blobContentType: contentType } });
    },
    deleteBlobs: async (paths) => {
      if (paths.length === 0) {
        return [];
      }
      await ready();
      return await deleteBatched(container, paths);
    },
    deletePrefix: async (prefix) => {
      // An empty prefix is the whole container: every project's bytes.
      if (prefix === "" || !prefix.endsWith("/")) {
        throw new Error("a feedback blob prefix names a project or a recording, and ends with /");
      }
      await ready();
      return await deleteUnder(container, prefix);
    }
  };
}

/** The most sub-requests Blob Storage takes in one batch. */
export const BLOB_BATCH_LIMIT = 256;

/** A sub-request that deleted its blob, or found it already gone. */
function deleted(status: number | undefined): boolean {
  return status === 202 || status === 404;
}

/**
 * `names` deleted `BLOB_BATCH_LIMIT` to a request, answering those that were not: a batch that fails whole fails
 * each of its names. Sub-responses come back in the order the requests were put in the batch.
 */
async function deleteBatched(container: ContainerClient, names: readonly string[]): Promise<string[]> {
  const batches = container.getBlobBatchClient();
  const failed: string[] = [];
  for (let at = 0; at < names.length; at += BLOB_BATCH_LIMIT) {
    const chunk = names.slice(at, at + BLOB_BATCH_LIMIT);
    try {
      const response = await batches.deleteBlobs(
        chunk.map((name) => container.getBlobClient(name)),
        { deleteSnapshots: "include" }
      );
      failed.push(...chunk.filter((_name, index) => !deleted(response.subResponses[index]?.status)));
    } catch {
      failed.push(...chunk);
    }
  }
  return failed;
}

async function deleteUnder(container: ContainerClient, prefix: string): Promise<number> {
  const names: string[] = [];
  for await (const blob of container.listBlobsFlat({ prefix })) {
    names.push(blob.name);
  }
  const failed = await deleteBatched(container, names);
  if (failed.length > 0) {
    throw new Error(`${failed.length} of the ${names.length} blobs under ${prefix} could not be deleted`);
  }
  return names.length;
}

const globalForBlobs = globalThis as unknown as { agentHubFeedbackBlobs?: { key: string; blobs: FeedbackBlobs } };

/**
 * The process's one blob client, or `undefined` when there is no storage configured. On `globalThis` because the
 * route handlers and the sweep are in separate module graphs, and one client keeps one delegation key.
 */
export function feedbackBlobs(env: Readonly<Record<string, string | undefined>> = process.env): FeedbackBlobs | undefined {
  const settings = feedbackBlobSettings(env);
  if (settings === undefined) {
    return undefined;
  }
  const key = JSON.stringify(settings);
  if (globalForBlobs.agentHubFeedbackBlobs?.key !== key) {
    globalForBlobs.agentHubFeedbackBlobs = { key, blobs: createFeedbackBlobs(settings) };
  }
  return globalForBlobs.agentHubFeedbackBlobs.blobs;
}
