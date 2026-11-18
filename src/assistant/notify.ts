import { BUILT_IN_PRODUCTS } from "@hmcts-cft/notify-tools/products";
import { z } from "zod";
import { jsonbText } from "./deck.ts";

/**
 * A conversation's GOV.UK Notify template as the hub keeps it: a draft of one template's subject and body, the
 * personalisation the person previews it with, and the template as Notify held it when the person's pod read it, which
 * is what the draft is compared with. The hub never holds the product's Notify API key: every read from Notify runs on
 * the pod, as the person. See "Notify templates" in docs/agent-api.md.
 */

/** The migration's CHECKs. Together they fit inside one agent API body, `MAX_REQUEST_BYTES`. */
export const MAX_NOTIFY_NAME = 500;
export const MAX_NOTIFY_SUBJECT = 1000;
export const MAX_NOTIFY_BODY = 40_000;
/** Notify's own preview, in UTF-8 bytes; a bigger one is not stored, and the panel previews locally instead. */
export const MAX_NOTIFY_PREVIEW_BYTES = 120_000;
/** The bytes of the data's jsonb text, as Postgres prints it. */
export const MAX_NOTIFY_DATA_BYTES = 40_000;
export const MAX_NOTIFY_SUMMARY = 200;
/** How many versions are kept. */
export const KEEP_NOTIFY_VERSIONS = 50;
/** Nesting of the data. Personalisation is flat, with lists at most, so this only stops a recursion. */
export const MAX_NOTIFY_DATA_DEPTH = 4;

export const NOTIFY_TYPES = ["email", "sms", "letter"] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];
export type NotifyAuthor = "agent" | "user";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The ids of the products whose Notify key a pod may read: the package's table, with nothing added. */
export const NOTIFY_PRODUCT_IDS: ReadonlySet<string> = new Set(BUILT_IN_PRODUCTS.map((product) => product.id));

const utf8 = new TextEncoder();

const storable = (text: string): boolean => jsonbText(text) !== undefined;
const UNSTORABLE = "must not contain a NUL character or half of a surrogate pair";

const text = (max: number) => z.string().max(max).refine(storable, { message: UNSTORABLE });
const trimmed = (max: number) => z.string().trim().min(1).max(max).refine(storable, { message: UNSTORABLE });

export const notifyProduct = z
  .string()
  .max(64)
  .refine((id) => NOTIFY_PRODUCT_IDS.has(id), { message: "is not a product with a Notify key the CFT Workspace knows" });

/** A Notify id, lowercased: Notify writes them in lowercase, and the column compares them as UUIDs. */
export const notifyId = z
  .string()
  .transform((id) => id.toLowerCase())
  .refine((id) => UUID_RE.test(id), { message: "must be a UUID" });

/** Where a version's template came from in Notify: the part a session's edit and the person's save copy from the version before. */
export const notifySource = z.strictObject({
  product: notifyProduct,
  template_id: notifyId,
  service_id: notifyId,
  type: z.enum(NOTIFY_TYPES),
  name: trimmed(MAX_NOTIFY_NAME),
  notify_version: z.number().int().min(1),
  notify_subject: text(MAX_NOTIFY_SUBJECT).nullable(),
  notify_body: text(MAX_NOTIFY_BODY),
  notify_preview: z
    .string()
    .refine(storable, { message: UNSTORABLE })
    .refine((preview) => utf8.encode(preview).byteLength <= MAX_NOTIFY_PREVIEW_BYTES, { message: `must be at most ${MAX_NOTIFY_PREVIEW_BYTES} bytes` })
    .nullable()
});

export type NotifySource = z.output<typeof notifySource>;

/** The body of `PUT …/notify`, with the data left for `checkNotifyData`. */
export const notifyPutBody = z.strictObject({
  subject: text(MAX_NOTIFY_SUBJECT).nullable(),
  body: text(MAX_NOTIFY_BODY),
  data: z.unknown(),
  base_version: z.number().int().nonnegative(),
  base_revision: z.number().int().nonnegative().optional(),
  summary: trimmed(MAX_NOTIFY_SUMMARY).optional(),
  source: notifySource.optional(),
  by: z.literal("user").optional()
});

export interface NotifyPut {
  subject: string | null;
  body: string;
  data: Record<string, unknown>;
  base_version: number;
  base_revision?: number;
  summary?: string;
  source?: NotifySource;
  /** A load the owner asked for from the panel's picker, which their pod writes through the agent path. */
  by?: "user";
}

/** The body of the person's save, `POST /api/ui/assistant/notify/{id}/save`. */
export const notifySaveBody = z.strictObject({
  subject: text(MAX_NOTIFY_SUBJECT).nullable(),
  body: text(MAX_NOTIFY_BODY),
  data: z.unknown(),
  base_version: z.number().int().min(1),
  base_revision: z.number().int().nonnegative()
});

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function issueText(issue: z.core.$ZodIssue): string {
  const [field, ...rest] = issue.path.map(String);
  const where = rest.map((part) => `.${part}`).join("");
  return `${field ?? "body"}${where} ${issue.message}`;
}

/** Whether `value` nests more than `max` levels of array or object, walked without recursion. */
function nestsDeeperThan(value: unknown, max: number): boolean {
  let level: unknown[] = [value];
  for (let depth = 0; level.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const item of level) {
      if (item !== null && typeof item === "object") {
        if (depth >= max) {
          return true;
        }
        next.push(...Object.values(item));
      }
    }
    level = next;
  }
  return false;
}

export function checkNotifyData(value: unknown): Checked<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "data must be an object" };
  }
  if (nestsDeeperThan(value, MAX_NOTIFY_DATA_DEPTH)) {
    return { ok: false, error: `data nests more than ${MAX_NOTIFY_DATA_DEPTH} levels` };
  }
  const stored = jsonbText(value);
  if (stored === undefined) {
    return { ok: false, error: "data has text the hub cannot store: a NUL character, or half of a surrogate pair" };
  }
  if (utf8.encode(stored).byteLength > MAX_NOTIFY_DATA_BYTES) {
    return { ok: false, error: `data is larger than ${MAX_NOTIFY_DATA_BYTES} bytes` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** A text message has no subject, and an email or letter always has one, which may be empty while it is drafted. */
export function subjectFits(type: NotifyType, subject: string | null): boolean {
  return (type === "sms") === (subject === null);
}

export function subjectRefusal(type: NotifyType): string {
  return type === "sms" ? "subject must be null for a text message" : `subject must be text for ${type === "email" ? "an email" : "a letter"}`;
}

/** The body of `PUT …/notify`, once every part is one the hub can store; otherwise the first problem, worded. */
export function checkNotifyPut(value: unknown): Checked<NotifyPut> {
  const parsed = notifyPutBody.safeParse(value);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    return { ok: false, error: first === undefined ? "the request body is not valid" : issueText(first) };
  }
  const { data: rawData, source, ...rest } = parsed.data;
  const data = checkNotifyData(rawData);
  if (!data.ok) {
    return data;
  }
  if (source !== undefined) {
    if (!subjectFits(source.type, rest.subject)) {
      return { ok: false, error: subjectRefusal(source.type) };
    }
    if (!subjectFits(source.type, source.notify_subject)) {
      return { ok: false, error: `source.notify_${subjectRefusal(source.type)}` };
    }
  }
  if (source === undefined && rest.base_version === 0) {
    return { ok: false, error: "source is needed for the first version: there is no version to take it from" };
  }
  return { ok: true, value: { ...rest, data: data.value, ...(source === undefined ? {} : { source }) } };
}

/** Refused for a conversation whose pod runs a client older than `items`, which reads only the primary Notify template. */
export const ITEMS_CREATE_REFUSED_NOTIFY = "your assistant needs an update to hold more than one Notify template; it gets one the next time it restarts";
