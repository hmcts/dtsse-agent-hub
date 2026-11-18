import type { IndexEntry, LibraryStatus } from "@/assistant/docmosis-library";
import { WAKING_RETRY_MS } from "@/components/assistant/AtlassianSearch";
import { type PodJobEvents, PodJobRefused, requestPodJob, waitForPodJob } from "@/components/assistant/podJobClient";

/**
 * The browser's end of the Docmosis template library and of loading a template from it. See "Docmosis template
 * library" in docs/agent-api.md.
 */

const LIBRARY_URL = "/api/ui/assistant/docmosis-library";
const LOAD_KIND = "docmosis.load";
/** How many times a load asks again while the assistant starts: about three minutes. */
const WAKING_RETRIES = 36;

export type LibraryRead = { ok: true; status: LibraryStatus } | { ok: false; status: number; error: string };

interface Options {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

async function libraryAnswer(response: Response): Promise<LibraryRead> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    return { ok: false, status: response.status, error: typeof body.error === "string" ? body.error : "The template list could not be read." };
  }
  return { ok: true, status: (await response.json()) as LibraryStatus };
}

/**
 * Opens the library, which may ask the pod to check GitHub. Only for the person opening the lookup or pressing
 * Refresh: every other read is `readLibrary`, or each answer would ask for the next check.
 */
export async function openLibrary(force: boolean, { signal, fetchImpl = fetch }: Options = {}): Promise<LibraryRead> {
  const response = await fetchImpl(LIBRARY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(force ? { force: true } : {}),
    ...(signal === undefined ? {} : { signal })
  });
  return await libraryAnswer(response);
}

export async function readLibrary({ signal, fetchImpl = fetch }: Options = {}): Promise<LibraryRead> {
  const response = await fetchImpl(LIBRARY_URL, { cache: "no-store", ...(signal === undefined ? {} : { signal }) });
  return await libraryAnswer(response);
}

/** The entries at the status's `entries_url`, which the browser caches for as long as that address stands. */
export async function libraryEntries(url: string, { signal, fetchImpl = fetch }: Options = {}): Promise<{ commit: string; entries: IndexEntry[] }> {
  const response = await fetchImpl(url, signal === undefined ? {} : { signal });
  if (!response.ok) {
    throw new Error(`the template list answered ${response.status}`);
  }
  return (await response.json()) as { commit: string; entries: IndexEntry[] };
}

export interface LoadRequest {
  path: string;
  blob_sha: string;
  base_version: number;
  base_revision: number;
}

/** How a load ended. `refused` is the hub turning the request down before anything ran on the pod. */
export type LoadOutcome =
  | { status: "done"; version: number; revision: number }
  | { status: "failed"; error: string; detail?: string }
  | { status: "refused"; httpStatus: number; error: string }
  | { status: "waking" | "unsupported" | "no_pod" | "assistant_gone" | "missing" };

export interface LoadOptions extends Options {
  events?: PodJobEvents;
  /** Told when the assistant is starting, so the panel can say what the load waits for. */
  onWaking?: () => void;
  /** Told once the pod has the job, after any wait for it to start. */
  onPending?: () => void;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

/**
 * Loads one template from the library into the conversation as the `docmosis.load` pod job: asked again every few
 * seconds while the assistant starts, then waited for. The new version reaches the page through the conversation's
 * own update, so `done` carries only which version the load wrote.
 */
export async function loadTemplate(
  conversationId: string,
  request: LoadRequest,
  { signal, fetchImpl = fetch, events, onWaking, onPending, wait = sleep, pollMs }: LoadOptions = {}
): Promise<LoadOutcome> {
  try {
    let asked = await requestPodJob(conversationId, LOAD_KIND, request, { signal, fetchImpl });
    for (let retries = WAKING_RETRIES; asked.status === "waking" && retries > 0 && signal?.aborted !== true; retries -= 1) {
      onWaking?.();
      await wait(WAKING_RETRY_MS, signal);
      asked = await requestPodJob(conversationId, LOAD_KIND, request, { signal, fetchImpl });
    }
    if (asked.status !== "pending") {
      return { status: asked.status };
    }
    onPending?.();
    const job = await waitForPodJob(conversationId, asked.job_id, { signal, fetchImpl, events, ...(pollMs === undefined ? {} : { pollMs }) });
    if (job.status === "missing") {
      return { status: "missing" };
    }
    if (job.status === "done") {
      const result = job.result as { version: number; revision: number };
      return { status: "done", version: result.version, revision: result.revision };
    }
    if (job.status === "timeout") {
      return { status: "failed", error: "timeout" };
    }
    return { status: "failed", error: job.error ?? "failed", ...(job.detail === undefined ? {} : { detail: job.detail }) };
  } catch (error) {
    if (error instanceof PodJobRefused) {
      return { status: "refused", httpStatus: error.status, error: error.message };
    }
    throw error;
  }
}

function sentence(words: string): string {
  const trimmed = words.trim();
  const capital = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** One plain sentence for a load that did not end in a new version; `conflict` is the panel's own choice, not this. */
export function loadFailureSentence(outcome: Exclude<LoadOutcome, { status: "done" }>): string {
  switch (outcome.status) {
    case "waking":
      return "Your assistant is still starting. Try again in a minute.";
    case "unsupported":
      return "Your assistant needs an update to load templates. It gets one the next time it restarts.";
    case "no_pod":
      return "Templates can only be loaded in a chat with an assistant of its own.";
    case "assistant_gone":
      return "This chat's assistant has been replaced, so it cannot load a template.";
    case "missing":
      return "The template did not load. Try again.";
    case "refused":
      if (outcome.httpStatus === 429) {
        return "You have loaded a lot of templates in the last few minutes. Try again shortly.";
      }
      return sentence(outcome.error);
    case "failed":
      switch (outcome.error) {
        case "signed_out":
          return "Sign in to GitHub in your assistant, then pick the template again.";
        case "sso":
          return "Your GitHub sign-in is not authorised for the hmcts organisation's single sign-on.";
        case "not_found":
          return "GitHub could not find that template, or your account cannot see it.";
        case "rate_limited":
          return "GitHub's rate limit has been reached. Try again later.";
        case "too_large":
          return "That template is larger than 5 MB, more than the Assistant can open.";
        case "not_docx":
          return "That file is not a Word document the Assistant can open.";
        case "checksum":
          return "The file GitHub sent did not match the template list. Try again.";
        case "schema_failed":
          return outcome.detail === undefined ? "The template's form could not be read." : `The template's form could not be read: ${outcome.detail}`;
        case "timeout":
          return "Your assistant did not load the template in time. Try again.";
        default:
          return outcome.detail === undefined ? "The template did not load. Try again." : sentence(outcome.detail);
      }
  }
}
