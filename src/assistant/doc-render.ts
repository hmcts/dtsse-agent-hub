import { isPdf, MAX_PDF_BYTES } from "./docmosis.ts";

const DEFAULT_DOC_RENDER_URL = "https://doc-render.aat.platform.hmcts.net";
const RENDER_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

export type RenderResult =
  | { ok: true; pdf: Uint8Array }
  | { ok: false; kind: "merge"; short: string; long: string }
  | { ok: false; kind: "busy"; retryAfter: number }
  | { ok: false; kind: "unreachable"; message: string };

export interface RenderRequest {
  docx: Uint8Array;
  data: unknown;
  name: string;
  signal?: AbortSignal;
}

function renderUrl(): string {
  const base = process.env.DOC_RENDER_URL?.trim() || DEFAULT_DOC_RENDER_URL;
  return `${base.replace(/\/+$/, "")}/api/render`;
}

function unreachable(message: string): RenderResult {
  return { ok: false, kind: "unreachable", message };
}

function tooLarge(): RenderResult {
  const short = "The rendered PDF is larger than 5 MiB";
  return { ok: false, kind: "merge", short, long: `${short}, which is more than the hub keeps. Shorten the template's content or the data and render again.` };
}

function retryAfterSeconds(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : DEFAULT_RETRY_AFTER_SECONDS;
}

async function mergeFailure(response: Response): Promise<RenderResult> {
  const body = (await response.json().catch(() => undefined)) as { shortMsg?: unknown; longMsg?: unknown } | undefined;
  if (typeof body?.shortMsg !== "string") {
    return unreachable(`doc-render answered ${response.status}`);
  }
  return { ok: false, kind: "merge", short: body.shortMsg, long: typeof body.longMsg === "string" ? body.longMsg : body.shortMsg };
}

/**
 * Renders a .docx template with `data` to a PDF on dtsse-doc-render. A plain `fetch`, since the service is on a private
 * address that the feedback `pinnedFetch` refuses. The service's own refusals come back as `merge` (the template or the
 * data is wrong) or `busy` (its queue is full); everything else, including a timeout and a reply that is no PDF, is
 * `unreachable`.
 */
export async function renderTemplate({ docx, data, name, signal }: RenderRequest): Promise<RenderResult> {
  const form = new FormData();
  form.set("templateFile", new Blob([Buffer.from(docx)]), `${name}.docx`);
  form.set("data", new Blob([JSON.stringify(data)], { type: "application/json" }), "data.json");
  form.set("outputFormat", "pdf");
  const timeout = AbortSignal.timeout(RENDER_TIMEOUT_MS);
  try {
    const response = await fetch(renderUrl(), { method: "POST", body: form, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (response.status === 503) {
      return { ok: false, kind: "busy", retryAfter: retryAfterSeconds(response.headers.get("retry-after")) };
    }
    if (response.status === 400) {
      return await mergeFailure(response);
    }
    if (!response.ok) {
      return unreachable(`doc-render answered ${response.status}`);
    }
    if (Number(response.headers.get("content-length")) > MAX_PDF_BYTES) {
      return tooLarge();
    }
    const pdf = new Uint8Array(await response.arrayBuffer());
    if (pdf.byteLength > MAX_PDF_BYTES) {
      return tooLarge();
    }
    return isPdf(pdf) ? { ok: true, pdf } : unreachable("doc-render did not answer with a PDF");
  } catch (error) {
    return unreachable(timeout.aborted ? "doc-render did not answer in time" : error instanceof Error ? error.message : String(error));
  }
}
