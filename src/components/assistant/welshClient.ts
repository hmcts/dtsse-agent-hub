import type { WelshKind, WelshResponse } from "@/assistant/welsh";

/**
 * The browser's end of the Welsh page's jobs: start one, read it back while it runs, upload a returned spreadsheet,
 * and the link that downloads one. See "Welsh translation jobs" in docs/agent-api.md.
 */

export interface WelshJobRequest {
  kind: WelshKind;
  product: string;
  args: Record<string, unknown>;
}

/** How often a running job is read back, and how often a job is tried again while the assistant starts. */
export const WELSH_POLL_MS = 2000;
export const WELSH_WAKING_RETRY_MS = 5000;
const WAKING_RETRIES = 36;

export interface WelshClient {
  start: (request: WelshJobRequest, signal?: AbortSignal) => Promise<WelshResponse>;
  read: (jobId: string, signal?: AbortSignal) => Promise<WelshResponse>;
  upload: (file: File) => Promise<{ file_id: string } | { error: string }>;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
}

async function answer(response: Response, fallback: string): Promise<WelshResponse> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    return { status: "failed", detail: typeof body.error === "string" ? sentence(body.error) : fallback };
  }
  return (await response.json()) as WelshResponse;
}

/** The hub's refusals are lowercase fragments; the page shows sentences. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return trimmed === "" ? trimmed : `${trimmed[0]?.toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}`;
}

export const welshClient: WelshClient = {
  start: async (request, signal) =>
    answer(
      await fetch("/api/ui/assistant/welsh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal }),
      "That did not work. Try again."
    ),
  read: async (jobId, signal) => answer(await fetch(`/api/ui/assistant/welsh/${encodeURIComponent(jobId)}`, { signal }), "That did not work. Try again."),
  upload: async (file) => {
    const response = await fetch("/api/ui/assistant/welsh/files", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
      body: file
    });
    const body = (await response.json().catch(() => ({}))) as { file_id?: unknown; error?: unknown };
    if (!response.ok || typeof body.file_id !== "string") {
      return { error: typeof body.error === "string" ? sentence(body.error) : "That spreadsheet could not be uploaded. Try again." };
    }
    return { file_id: body.file_id };
  },
  wait: (ms, signal) =>
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
    })
};

export function welshDownloadUrl(fileId: string): string {
  return `/api/ui/assistant/welsh/files/${encodeURIComponent(fileId)}`;
}

/**
 * Starts a job and follows it to its end: tried again while the assistant starts, and read back while it runs.
 * `onProgress` hears each in-between state, so the page can say what it is waiting for.
 */
export async function runWelshJob(
  client: WelshClient,
  request: WelshJobRequest,
  { signal, onProgress }: { signal?: AbortSignal; onProgress?: (state: "waking" | "pending") => void } = {}
): Promise<WelshResponse> {
  let response = await client.start(request, signal);
  for (let retry = 0; response.status === "waking" && retry < WAKING_RETRIES && !signal?.aborted; retry++) {
    onProgress?.("waking");
    await client.wait(WELSH_WAKING_RETRY_MS, signal);
    response = await client.start(request, signal);
  }
  while (response.status === "pending" && !signal?.aborted) {
    onProgress?.("pending");
    const jobId = response.job_id;
    await client.wait(WELSH_POLL_MS, signal);
    response = await client.read(jobId, signal);
  }
  return response;
}
