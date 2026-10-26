// GitHub's OAuth device flow, polled by this client rather than by `gh auth login --web`.
//
// gh cannot be used for the flow because `cli/oauth`'s `device.Wait` ends the sign-in on the first poll answer
// that is neither `authorization_pending` nor a single `slow_down`: a 429, a 5xx, a dropped connection, a
// timeout or a second `slow_down` all return at once and gh exits 1, throwing away a device code the owner is
// still holding. A laptop user retries; a pod has nobody to retry for it, so a sign-in nobody could complete
// is the only outcome. Polled here, a transient answer costs a wait instead of the code.
//
// Measured against github.com, which is what the rules below encode:
//
//   - every OAuth-level outcome comes back as HTTP 200 with the answer in the body, `access_denied` included,
//     so a status that is not 200 and carries no `error` is between the pod and GitHub rather than about the
//     sign-in, and is worth waiting out;
//   - the body is `application/x-www-form-urlencoded` unless `Accept: application/json` is sent;
//   - `slow_down`'s counter is kept per device code, is cumulative and never resets: each one permanently adds
//     5s to that code's own required interval, observed climbing 10, 15, 20 … 125 over a burst of 25 polls.
//     The `interval` the answer carries is therefore the one to honour, and a second `slow_down` says nothing
//     about the clock — which is what gh's own bail-out assumes it does.
//
// Polling with headroom over the server's minimum follows from that last point: a poll that arrives early
// costs the code 5 extra seconds for the rest of its life, and the code is the owner's only way in.
import type { Env } from "../env.ts";

export const GITHUB_OAUTH_HOST = "https://github.com";
/** The flow's two endpoints on `host`, which is `GITHUB_OAUTH_HOST` for github.com. */
export const deviceCodeUrl = (host: string): string => `${host.replace(/\/+$/, "")}/login/device/code`;
export const tokenUrl = (host: string): string => `${host.replace(/\/+$/, "")}/login/oauth/access_token`;

/**
 * The "GitHub CLI" OAuth app: the public client id every gh binary carries in `internal/authflow/flow.go`.
 * It identifies an app rather than authenticating one — the device flow sends no client secret — so it is not
 * a credential, and the pods already authorise this same app whenever they run `gh auth login`, which is what
 * makes driving its flow here ask their owners for nothing they were not already asked for.
 */
export const GITHUB_CLIENT_ID = "178c6fc778ccc68e1d6a";

/**
 * The scopes gh asks for in a pod: its own minimum (`internal/authflow/flow.go`) plus the `user:email` that
 * lets `git-identity.ts` check the owner's HMCTS address is on their account. `repo` is what makes the token
 * able to clone an internal repo, which is the whole reason stage 0 signs in at all.
 */
export const GITHUB_SCOPES = "repo read:org gist user:email";

export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** What a code gets when the answer does not say. github.com says 900 and 5. */
export const DEFAULT_EXPIRES_IN_S = 900;
export const DEFAULT_INTERVAL_S = 5;

/** The floor under a host that answers `interval=0`, so an unreadable minimum cannot become a tight loop. */
export const MIN_INTERVAL_S = 1;

/**
 * How many times the server's minimum interval a poll actually waits. Two, because `slow_down` is permanent
 * per code: a poll that lands early costs that code 5 seconds for the rest of its life, where waiting double
 * costs the owner a few extra seconds once, after they have typed the code. It also halves what the pods ask
 * of the endpoint for as long as nobody signs in.
 */
export const POLL_INTERVAL_MULTIPLIER = 2;

/** ±20% on every wait, so pods that booted together stop asking together. */
export const POLL_JITTER = 0.2;

/** What a fault with nothing to go on waits, and the most any `Retry-After` is honoured for. */
export const TRANSIENT_WAIT_S = 15;
export const MAX_TRANSIENT_WAIT_S = 120;

export const REQUEST_TIMEOUT_MS = 20000;

/**
 * The device flow's own refusals. Every one of them is the owner's answer or the app's registration, and no
 * amount of waiting changes any of them.
 */
export const FATAL_DEVICE_ERRORS = [
  "access_denied",
  "device_flow_disabled",
  "expired_token",
  "incorrect_client_credentials",
  "incorrect_device_code",
  "unauthorized_client",
  "unsupported_grant_type"
] as const;

export type DeviceCode = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

/** One poll's answer, read off the response and nothing else. */
export type PollAnswer =
  | { outcome: "token"; token: string }
  | { outcome: "pending" }
  /** `interval` is the server's new minimum for this code, or null when it did not say one. */
  | { outcome: "slow-down"; interval: number | null }
  | { outcome: "retry"; seconds: number | null; detail: string }
  | { outcome: "fatal"; error: string; detail: string };

export type PollResult =
  | { outcome: "token"; token: string }
  /** The code was on the owner's screen until it ran out. Nothing broke; nobody used it. */
  | { outcome: "expired" }
  | { outcome: "refused"; error: string; detail: string };

/** A device-flow request GitHub refused, or that could not be made. `retryable`: whether asking again could work. */
export class DeviceFlowError extends Error {
  readonly retryable: boolean;
  /** The OAuth error code, when the answer carried one. */
  readonly error: string;

  constructor(message: string, { retryable, error = "" }: { retryable: boolean; error?: string }) {
    super(message);
    this.name = "DeviceFlowError";
    this.retryable = retryable;
    this.error = error;
  }
}

/** Whether `withRetry` should try a failed device-flow call again. Anything that is not ours gets another go. */
export function deviceFlowRetryable(error: unknown): boolean {
  return error instanceof DeviceFlowError ? error.retryable : true;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The response body as a flat map. The shape is taken from the body rather than the `Content-Type`, because a
 * proxy or a captive portal answering in place of GitHub gets the header wrong before it gets the body wrong:
 * an HTML page read as a form yields keys that are neither `error` nor `access_token`, which leaves the status
 * to classify it, and that is the right answer for a page GitHub did not write.
 */
export function parseOAuthBody(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (text.trimStart().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return out;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return out;
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        out[key] = value;
      } else if (typeof value === "number") {
        out[key] = String(value);
      }
    }
    return out;
  }
  for (const [key, value] of new URLSearchParams(text)) {
    out[key] = value;
  }
  return out;
}

/** A positive integer from a form or JSON value, or null: a `0`, a `-1` and a word are all "did not say". */
export function positiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) {
    return null;
  }
  const n = Number(value.trim());
  return n > 0 ? n : null;
}

/** `Retry-After` in seconds. Only the delta-seconds form is read; GitHub sends that one, and an HTTP-date waits the default. */
export function retryAfterSeconds(header: string | null): number | null {
  return header === null ? null : positiveInt(header);
}

function describe(values: Record<string, string>, fallback: string): string {
  const description = values.error_description?.trim();
  return description ? description : fallback;
}

/**
 * One poll's answer, from the status, the `Retry-After` and the parsed body. Pure, and the single place the
 * flow decides whether an answer ends the sign-in or only delays it.
 */
export function classifyPollAnswer(status: number, retryAfter: number | null, values: Record<string, string>): PollAnswer {
  const token = values.access_token;
  if (token) {
    return { outcome: "token", token };
  }
  const error = values.error ?? "";
  if (error === "authorization_pending") {
    return { outcome: "pending" };
  }
  if (error === "slow_down") {
    return { outcome: "slow-down", interval: positiveInt(values.interval) };
  }
  if (error !== "") {
    // GitHub's device-flow error set is closed, and an answer outside it is still GitHub refusing this flow
    // rather than a fault to wait out: the code is spent either way, so it is named and the attempt ends.
    return { outcome: "fatal", error, detail: `GitHub answered ${error}: ${describe(values, "no description given")}` };
  }
  if (status === 200) {
    // GitHub answers 200 with a token or with an `error`, never with neither. Something is answering for it.
    return { outcome: "fatal", error: "", detail: "GitHub answered 200 with neither a token nor an error" };
  }
  return { outcome: "retry", seconds: retryAfter, detail: `GitHub answered HTTP ${status}` };
}

export type DeviceFlowRequestOptions = {
  env?: Env;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function flowConfig(env: Env): { host: string; clientId: string } {
  return { host: env.GITHUB_OAUTH_HOST || GITHUB_OAUTH_HOST, clientId: env.GITHUB_OAUTH_CLIENT_ID || GITHUB_CLIENT_ID };
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

const POST_HEADERS = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };

/** Mints a device code for the owner to enter. Throws `DeviceFlowError`; `retryable` says whether to ask again. */
export async function requestDeviceCode({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS
}: DeviceFlowRequestOptions = {}): Promise<DeviceCode> {
  const { host, clientId } = flowConfig(env);
  let status: number;
  let values: Record<string, string>;
  try {
    const res = await fetchImpl(deviceCodeUrl(host), {
      method: "POST",
      headers: POST_HEADERS,
      body: form({ client_id: clientId, scope: GITHUB_SCOPES }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    status = res.status;
    values = parseOAuthBody(await res.text());
  } catch (e) {
    throw new DeviceFlowError(`could not reach GitHub for a device code (${(e as Error).message})`, { retryable: true });
  }
  const error = values.error ?? "";
  if (error !== "") {
    throw new DeviceFlowError(`GitHub would not give a device code: ${error} (${describe(values, "no description given")})`, {
      retryable: !(FATAL_DEVICE_ERRORS as readonly string[]).includes(error),
      error
    });
  }
  if (status !== 200) {
    throw new DeviceFlowError(`GitHub answered HTTP ${status} for a device code`, { retryable: true });
  }
  const { device_code, user_code, verification_uri } = values;
  if (!device_code || !user_code || !verification_uri?.startsWith("https://")) {
    // Relayed to a person, so the page they are sent to has to be one GitHub named over TLS.
    throw new DeviceFlowError("GitHub answered a device-code request without a code and an https page to enter it on", { retryable: true });
  }
  return {
    device_code,
    user_code,
    verification_uri,
    expires_in: positiveInt(values.expires_in) ?? DEFAULT_EXPIRES_IN_S,
    interval: positiveInt(values.interval) ?? DEFAULT_INTERVAL_S
  };
}

export type PollDeviceTokenOptions = DeviceFlowRequestOptions & {
  code: DeviceCode;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Said once per distinct reason, so a fault the owner's sign-in survived is still in the pod's log. */
  onWait?: (detail: string) => void;
};

/** The wait before the next poll: the server's minimum with headroom, jittered. */
export function nextWaitSeconds(intervalS: number, random: () => number): number {
  const base = Math.max(MIN_INTERVAL_S, intervalS) * POLL_INTERVAL_MULTIPLIER;
  return base * (1 + POLL_JITTER * (random() * 2 - 1));
}

async function pollOnce(url: string, body: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<PollAnswer> {
  try {
    const res = await fetchImpl(url, { method: "POST", headers: POST_HEADERS, body, signal: AbortSignal.timeout(timeoutMs) });
    return classifyPollAnswer(res.status, retryAfterSeconds(res.headers.get("retry-after")), parseOAuthBody(await res.text()));
  } catch (e) {
    // A reset, a TLS fault or a timeout. This is where gh ends the sign-in; the code is still good, so it waits.
    return { outcome: "retry", seconds: null, detail: `the poll could not reach GitHub (${(e as Error).message})` };
  }
}

/**
 * Polls until the owner completes the sign-in, GitHub refuses it, or the code runs out. Only those three end
 * it: every fault is a wait, because the code outlives the fault and the owner cannot be given another one
 * without the one they are holding going dead.
 */
export async function pollDeviceToken({
  code,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  wait = sleep,
  now = Date.now,
  random = Math.random,
  onWait
}: PollDeviceTokenOptions): Promise<PollResult> {
  const { host, clientId } = flowConfig(env);
  const url = tokenUrl(host);
  const body = form({ client_id: clientId, device_code: code.device_code, grant_type: GRANT_TYPE });
  const deadline = now() + code.expires_in * 1000;
  let interval = code.interval;
  let waitS = nextWaitSeconds(interval, random);
  let said = "";
  const say = (detail: string) => {
    if (detail !== said) {
      said = detail;
      onWait?.(detail);
    }
  };
  for (;;) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return { outcome: "expired" };
    }
    await wait(Math.min(waitS * 1000, remainingMs));
    const answer = await pollOnce(url, body, fetchImpl, timeoutMs);
    switch (answer.outcome) {
      case "token":
        return { outcome: "token", token: answer.token };
      case "fatal":
        return { outcome: "refused", error: answer.error, detail: answer.detail };
      case "pending":
        waitS = nextWaitSeconds(interval, random);
        break;
      case "slow-down":
        // The server's own new minimum when it gave one; the RFC's +5 when it did not.
        interval = answer.interval ?? interval + 5;
        waitS = nextWaitSeconds(interval, random);
        say(`GitHub asked for a slower poll; waiting ${Math.round(waitS)}s between tries`);
        break;
      case "retry":
        waitS = Math.min(MAX_TRANSIENT_WAIT_S, Math.max(answer.seconds ?? TRANSIENT_WAIT_S, nextWaitSeconds(interval, random)));
        say(`${answer.detail}; the code is still good, so this waits ${Math.round(waitS)}s and asks again`);
        break;
    }
  }
}
