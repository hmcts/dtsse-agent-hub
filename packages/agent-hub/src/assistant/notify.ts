// A product's GOV.UK Notify templates, read on the pod with its owner's own `az login`: the product's Notify API key is
// read from its AAT Key Vault here and used here, and never sent to the hub. `agent-hub notify list|pull` and the
// Notify panel's `notify.list` and `notify.pull` pod jobs both run these. See "Notify templates" in dtsse-agent-hub's
// docs/agent-api.md.
import { apiPersonalisation, findPlaceholders, type NotifyTemplate } from "@hmcts-cft/docmosis-tools/notify";
import { KeyVaultError, NotifyApiError, NotifyClient, readSecret } from "@hmcts-cft/docmosis-tools/notify/node";
import { BUILT_IN_PRODUCTS, type NotifyProduct } from "@hmcts-cft/docmosis-tools/notify/products";
import type { Api } from "../api.ts";
import { ApiError } from "../api.ts";
import { CLI } from "../envelope.ts";
import type { NotifyBody, NotifyResponse, NotifySource, NotifyTemplateType } from "../wire.ts";
import { MAX_BODY, MAX_NAME, MAX_PREVIEW_BYTES, MAX_SUBJECT } from "./notify-tools.ts";
import { PodJobError } from "./pod-jobs.ts";

/** The hub's request cap, less room for the JSON's own framing. */
const MAX_PUT_BYTES = 250 * 1024;
/** The hub's cap on a list's templates. */
export const MAX_LISTED = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const utf8 = new TextEncoder();

/** What reading Notify needs; a test passes its own. */
export type NotifyDeps = {
  products?: readonly Readonly<NotifyProduct>[];
  readKey?: (vault: string, secret: string) => Promise<string>;
  client?: (apiKey: string, signal?: AbortSignal) => Pick<NotifyClient, "serviceId" | "listTemplates" | "getTemplate" | "previewTemplate">;
};

type Author = NotifyResponse["by"];

export type ListedTemplate = { id: string; name: string; type: NotifyTemplateType; version: number };

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const TYPE_ORDER: Record<NotifyTemplateType, number> = { email: 0, sms: 1, letter: 2 };

export function notifyProducts(deps: NotifyDeps = {}): readonly Readonly<NotifyProduct>[] {
  return deps.products ?? BUILT_IN_PRODUCTS;
}

/** The product named `id`, or `unknown_product`. */
export function productOf(id: string, deps: NotifyDeps = {}): Readonly<NotifyProduct> {
  const found = notifyProducts(deps).find((product) => product.id === id);
  if (found === undefined) {
    throw new PodJobError("unknown_product", `There is no product "${id}" with a Notify key. Run ${CLI} notify products for the ones there are.`);
  }
  return found;
}

/**
 * A failure reading the key or Notify as the code the panel branches on, with the package's own words, which name the
 * vault, the secret or what Notify said. `undefined` for anything else, which is not a Notify failure at all.
 */
export function notifyFailure(e: unknown): PodJobError | undefined {
  if (e instanceof PodJobError) {
    return e;
  }
  if (e instanceof KeyVaultError) {
    const { message } = e;
    if (/isn't installed/.test(message)) {
      return new PodJobError("az_missing", message);
    }
    if (/run `az login`/.test(message)) {
      return new PodJobError("az_login", message);
    }
    if (/^Forbidden/.test(message)) {
      return new PodJobError("forbidden", message);
    }
    if (/has no secret named|is empty/.test(message)) {
      return new PodJobError("secret_not_found", message);
    }
    return new PodJobError("keyvault_error", message);
  }
  if (e instanceof NotifyApiError) {
    if (e.status === 401 || e.status === 403) {
      return new PodJobError("notify_forbidden", e.message);
    }
    return new PodJobError(e.status === 404 ? "not_found" : "notify_error", e.message);
  }
  if (e instanceof Error && /isn't a GOV\.UK Notify API key/.test(e.message)) {
    return new PodJobError("bad_key", e.message);
  }
  if (e instanceof Error && /^Can't reach GOV\.UK Notify/.test(e.message)) {
    return new PodJobError("notify_error", e.message);
  }
  return undefined;
}

async function explained<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw notifyFailure(e) ?? e;
  }
}

const newClient = (apiKey: string, signal?: AbortSignal): NotifyClient =>
  new NotifyClient(apiKey, signal === undefined ? undefined : { fetchImpl: (url, init) => fetch(url, { ...init, signal: init?.signal ?? signal }) });

/**
 * A Notify client on the product's key, read with the person's own `az login`, whose every call stops with `signal`.
 * The Key Vault read takes no signal: the package gives `az` a timeout of its own.
 */
async function clientFor(product: Readonly<NotifyProduct>, deps: NotifyDeps, signal?: AbortSignal): Promise<ReturnType<NonNullable<NotifyDeps["client"]>>> {
  const read = deps.readKey ?? ((vault: string, secret: string) => readSecret(vault, secret));
  const key = await explained(() => read(product.vault, product.secret));
  return await explained(async () => (deps.client ?? newClient)(key, signal));
}

/** The product's templates, emails first, then text messages, then letters, each by name; at most `MAX_LISTED`. */
export async function listNotifyTemplates(productId: string, deps: NotifyDeps = {}): Promise<{ templates: ListedTemplate[]; truncated: boolean }> {
  const client = await clientFor(productOf(productId, deps), deps);
  const all = await explained(() => client.listTemplates());
  const templates = all
    .filter((template) => UUID_RE.test(template.id) && template.version >= 1)
    .map((template) => ({ id: template.id.toLowerCase(), name: clip(template.name, MAX_NAME), type: template.type, version: template.version }))
    .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || byCodePoint(a.name, b.name) || byCodePoint(a.id, b.id));
  return { templates: templates.slice(0, MAX_LISTED), truncated: templates.length > MAX_LISTED };
}

function clip(text: string, max: number): string {
  const trimmed = text.trim() || "Untitled";
  if (trimmed.length <= max) {
    return trimmed;
  }
  const cut = trimmed.slice(0, max - 1);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

const bytes = (text: string): number => utf8.encode(text).byteLength;

/** The template as a version's source: Notify's text, and Notify's own preview of it with every placeholder shown as `((name))`. */
function sourceOf(productId: string, template: NotifyTemplate, serviceId: string, preview: string | null): NotifySource {
  const subject = template.type === "sms" ? null : (template.subject ?? "");
  if (template.body.length > MAX_BODY || (subject?.length ?? 0) > MAX_SUBJECT) {
    throw new PodJobError(
      "too_large",
      `The template "${template.name}" is too big for the CFT Workspace: its body is at most ${MAX_BODY} characters and its subject ${MAX_SUBJECT}.`
    );
  }
  return {
    product: productId,
    template_id: template.id.toLowerCase(),
    service_id: serviceId.toLowerCase(),
    type: template.type,
    name: clip(template.name, MAX_NAME),
    notify_version: template.version,
    notify_subject: subject,
    notify_body: template.body,
    notify_preview: preview !== null && bytes(preview) <= MAX_PREVIEW_BYTES ? preview : null
  };
}

/** Notify's preview with no personalisation, or `null` when Notify would not give one or could not be reached, which the panel previews locally instead. */
async function previewOf(client: Awaited<ReturnType<typeof clientFor>>, template: NotifyTemplate, signal?: AbortSignal): Promise<string | null> {
  const { personalisation } = apiPersonalisation(findPlaceholders(template.subject, template.body), {});
  try {
    const preview = await client.previewTemplate(template.id, personalisation, signal);
    return template.type === "email" ? (preview.html ?? null) : preview.body;
  } catch (e) {
    if (signal?.aborted) {
      throw e;
    }
    return null;
  }
}

/** Whether `current` is this template at this Notify version, loaded and not changed since: loading it again would write a copy. */
function alreadyLoaded(current: NotifyResponse | undefined, source: NotifySource, by: Author): boolean {
  return (
    current !== undefined &&
    current.by === by &&
    current.template_id === source.template_id &&
    current.notify_version === source.notify_version &&
    current.subject === source.notify_subject &&
    current.body === source.notify_body &&
    Object.keys(current.data).length === 0
  );
}

async function currentOf(api: Pick<Api, "getNotify">, agentId: string): Promise<NotifyResponse | undefined> {
  try {
    return await api.getNotify(agentId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return undefined;
    }
    throw e;
  }
}

/** The body of the put, with Notify's preview left out when the whole would pass the hub's request cap. */
function putBody(source: NotifySource, base: number, by: Author): NotifyBody {
  const body: NotifyBody = {
    subject: source.notify_subject,
    body: source.notify_body,
    data: {},
    base_version: base,
    summary: `Loaded version ${source.notify_version} from Notify`,
    source,
    ...(by === "user" ? { by } : {})
  };
  if (bytes(JSON.stringify(body)) <= MAX_PUT_BYTES) {
    return body;
  }
  const lighter = { ...body, source: { ...source, notify_preview: null } };
  if (bytes(JSON.stringify(lighter)) <= MAX_PUT_BYTES) {
    return lighter;
  }
  throw new PodJobError("too_large", `The template "${source.name}" is too big for the CFT Workspace to hold.`);
}

/**
 * Loads one of the product's templates into the conversation as its Notify template's next version, with no
 * personalisation: by the session, or `by: "user"` for the panel's picker, so the session is told the person changed it.
 * Safe to run twice: a template already loaded at the same Notify version, and not changed since, is answered as it
 * is, so a pod that runs a job again after a crash writes no copy of it. A newer version written while it loaded is
 * `conflict`.
 */
export async function pullNotifyTemplate({
  productId,
  templateId,
  agentId,
  api,
  deps = {},
  signal,
  by = "agent"
}: {
  productId: string;
  templateId: string;
  agentId: string;
  api: Pick<Api, "getNotify" | "putNotify">;
  deps?: NotifyDeps;
  signal?: AbortSignal;
  by?: Author;
}): Promise<{ version: number; name: string; written: boolean }> {
  if (!UUID_RE.test(templateId)) {
    throw new PodJobError("not_found", `"${templateId}" is not a Notify template id, which is a UUID.`);
  }
  const product = productOf(productId, deps);
  const before = await currentOf(api, agentId);
  const client = await clientFor(product, deps, signal);
  const template = await explained(() => client.getTemplate(templateId));
  const source = sourceOf(product.id, template, client.serviceId, await previewOf(client, template, signal));
  if (before !== undefined && alreadyLoaded(before, source, by)) {
    return { version: before.version, name: source.name, written: false };
  }
  signal?.throwIfAborted();
  try {
    const written = await api.putNotify(agentId, putBody(source, before?.version ?? 0, by));
    return { version: written.version, name: source.name, written: true };
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) {
      throw e;
    }
    const current = e.body?.current as NotifyResponse | undefined;
    if (current !== undefined && alreadyLoaded(current, source, by)) {
      return { version: current.version, name: source.name, written: false };
    }
    throw new PodJobError("conflict", "The Notify template in this chat changed while it was loading. Try again.");
  }
}
