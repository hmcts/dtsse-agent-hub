import type { Environment } from "../auth/settings.ts";
import { viewerSettings } from "../port-viewer/settings.ts";

/**
 * The prototype feedback flag and where its blobs go, read per call from the environment because the chart's secrets
 * reach `process.env` only once `instrumentation.ts` has loaded them.
 */

export const DEFAULT_FEEDBACK_CONTAINER = "feedback";

/**
 * Where recordings and snapshots are kept. Deployed, `accountUrl` with the hub's managed identity, which signs SAS
 * from a user delegation key since the account has no keys. Locally, Azurite's `connectionString`, which signs them
 * with its well-known account key; set, it wins over `accountUrl`.
 */
export type FeedbackBlobSettings = { container: string } & ({ kind: "identity"; accountUrl: string } | { kind: "connection"; connectionString: string });

// Azure's rule for a container name: 3–63 lower-case letters, digits and single hyphens, starting and ending alphanumeric.
const CONTAINER = /^(?=.{3,63}$)[a-z0-9]+(-[a-z0-9]+)*$/;

function accountUrlOf(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || !URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  return url.protocol === "https:" && url.search === "" ? url.origin : undefined;
}

/** The blob settings, or `undefined` when there are none to use: no account, or a container name Azure would refuse. */
export function feedbackBlobSettings(env: Environment = process.env): FeedbackBlobSettings | undefined {
  const container = env.FEEDBACK_STORAGE_CONTAINER?.trim() || DEFAULT_FEEDBACK_CONTAINER;
  if (!CONTAINER.test(container)) {
    return undefined;
  }
  const connectionString = env.FEEDBACK_STORAGE_CONNECTION_STRING?.trim();
  if (connectionString) {
    return { kind: "connection", connectionString, container };
  }
  const accountUrl = accountUrlOf(env.FEEDBACK_STORAGE_ACCOUNT_URL);
  return accountUrl === undefined ? undefined : { kind: "identity", accountUrl, container };
}

/**
 * Off unless `FEEDBACK_ENABLED=true` and both halves it stands on are configured: the viewer, which frames the
 * prototype through its proxy, and Blob Storage, where recordings go. Off, the menu item is hidden, every feedback
 * route and page answers 404 and the sweep does not run.
 */
export function feedbackEnabled(env: Environment = process.env): boolean {
  return env.FEEDBACK_ENABLED === "true" && viewerSettings(env) !== undefined && feedbackBlobSettings(env) !== undefined;
}
