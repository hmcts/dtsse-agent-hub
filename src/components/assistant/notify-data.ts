import type { PodJobOutcome } from "@/components/assistant/podJobClient";

/**
 * The Notify panel's data: what the hub's routes answer, the pod jobs' results, the line diff against Notify's text,
 * the HTML clean-up every preview goes through, and the words for each way a pod job can fail.
 */

export type NotifyType = "email" | "sms" | "letter";
export type JsonObject = { [key: string]: unknown };

/** What the page carries about the latest version: `src/assistant/notify-store.ts`'s `NotifySummary`. */
export interface NotifySummary {
  name: string;
  version: number;
  revision: number;
  updatedBy: "user" | "agent";
}

/** One version, as `GET /api/ui/assistant/notify/{id}` answers it. */
export interface NotifyView {
  version: number;
  revision: number;
  product: string;
  template_id: string;
  service_id: string;
  type: NotifyType;
  name: string;
  subject: string | null;
  body: string;
  notify_version: number;
  notify_subject: string | null;
  notify_body: string;
  notify_preview: string | null;
  data: JsonObject;
  by: "user" | "agent";
  summary: string | null;
  updated_at: string;
  current_version?: number;
}

export interface NotifyVersionEntry {
  version: number;
  by: "user" | "agent";
  name: string;
  notify_version: number;
  summary: string | null;
  updated_at: string;
}

/** One template of a `notify.list` job's result. */
export interface ListedTemplate {
  id: string;
  name: string;
  type: NotifyType;
  version: number;
}

export function notifyUrl(conversationId: string): string {
  return `/api/ui/assistant/notify/${encodeURIComponent(conversationId)}`;
}
export const notifySaveUrl = (conversationId: string): string => `${notifyUrl(conversationId)}/save`;
export const notifyVersionsUrl = (conversationId: string): string => `${notifyUrl(conversationId)}/versions`;
export const notifyVersionUrl = (conversationId: string, version: number): string => `${notifyUrl(conversationId)}/versions/${version}`;

export const TYPE_LABELS: Record<NotifyType, string> = { email: "Emails", sms: "Text messages", letter: "Letters" };
export const TYPE_NAMES: Record<NotifyType, string> = { email: "Email", sms: "Text message", letter: "Letter" };

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The list as the template picker shows it: a group per type, emails first, each sorted by name. Empty groups are left out. */
export function groupTemplates(templates: readonly ListedTemplate[]): { type: NotifyType; label: string; templates: ListedTemplate[] }[] {
  return (["email", "sms", "letter"] as const)
    .map((type) => ({
      type,
      label: TYPE_LABELS[type],
      templates: templates.filter((template) => template.type === type).sort((a, b) => byCodePoint(a.name, b.name) || byCodePoint(a.id, b.id))
    }))
    .filter((group) => group.templates.length > 0);
}

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Beyond this many line pairs the diff is a plain replacement: the table it builds is that many numbers. */
const MAX_DIFF_CELLS = 4_000_000;

/** The lines of `after` against `before`: a longest common subsequence, removals before additions where they meet. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (before === after) {
    return a.map((text) => ({ kind: "same", text }));
  }
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return [...a.map((text): DiffLine => ({ kind: "removed", text })), ...b.map((text): DiffLine => ({ kind: "added", text }))];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i] as string });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      lines.push({ kind: "removed", text: a[i] as string });
      i += 1;
    } else {
      lines.push({ kind: "added", text: b[j] as string });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) {
    lines.push({ kind: "removed", text: a[i] as string });
  }
  for (; j < b.length; j += 1) {
    lines.push({ kind: "added", text: b[j] as string });
  }
  return lines;
}

/** Elements dropped with everything inside them: what runs code, loads other documents, styles the page or submits. */
const DROPPED = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "link",
  "meta",
  "base",
  "noscript",
  "template"
]);
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "background", "poster", "cite", "longdesc"]);

function safeUrl(value: string): boolean {
  const url = value.trim();
  return url.startsWith("#") || /^(https?:|mailto:)/i.test(url);
}

/** A style that cannot fetch or run anything: no `url()` other than an https one, and none of old IE's `expression()`. */
function safeStyle(value: string): boolean {
  return !/expression\s*\(|javascript:|url\s*\(\s*['"]?\s*(?!https:)/i.test(value);
}

/**
 * `html` with nothing in it that runs or loads anything but pictures and links over http(s): the `DROPPED` elements,
 * every `on*` attribute, `srcset`, and a URL or style that is not `safeUrl` or `safeStyle`. Links open in a new tab.
 * The preview is a Notify template's own markup, but a draft can hold anything, and Notify's preview is only as safe
 * as the template's author made it, so every preview goes through this before it is shown.
 */
export function sanitiseHtml(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const walk = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      if (DROPPED.has(child.tagName.toLowerCase())) {
        child.remove();
        continue;
      }
      for (const attribute of Array.from(child.attributes)) {
        const name = attribute.name.toLowerCase();
        if (
          name.startsWith("on") ||
          name === "srcset" ||
          (URL_ATTRIBUTES.has(name) && !safeUrl(attribute.value)) ||
          (name === "style" && !safeStyle(attribute.value))
        ) {
          child.removeAttribute(attribute.name);
        }
      }
      if (child.tagName.toLowerCase() === "a" && child.hasAttribute("href")) {
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer");
      }
      walk(child);
    }
  };
  walk(document.body);
  return document.body.innerHTML;
}

/** A draft that is Notify's own text with nothing filled in, which is exactly what Notify's preview shows. */
export function showsNotifyPreview(view: NotifyView, subject: string | null, body: string, data: JsonObject): boolean {
  return view.notify_preview !== null && subject === view.notify_subject && body === view.notify_body && Object.keys(data).length === 0;
}

/** What each code a Notify pod job fails with means, when the pod sent no words of its own. */
const ERROR_WORDS: Record<string, string | undefined> = {
  unknown_product: "That product has no Notify key the CFT Workspace knows.",
  az_missing: "Your assistant has no Azure CLI.",
  az_login: "Your assistant is not signed in to Azure. Sign in from the settings, then try again.",
  forbidden: "You have no read access to that product's Key Vault.",
  secret_not_found: "The product's Key Vault has no Notify key under the expected name.",
  keyvault_error: "The product's Notify key could not be read.",
  bad_key: "The product's Key Vault holds something that is not a Notify API key.",
  notify_forbidden: "GOV.UK Notify refused the product's key.",
  not_found: "GOV.UK Notify has no such template.",
  notify_error: "GOV.UK Notify could not be reached, or answered with an error.",
  no_session: "This chat has no assistant session yet. Send it a message, then try again.",
  conflict: "The Notify template in this chat changed while it was loading. Try again.",
  too_large: "That template is too big for the CFT Workspace.",
  tools_missing: "Your assistant has no GOV.UK Notify support installed. Restart it from the settings to update it, then try again."
};

const TOO_SLOW = "That took too long. Try again.";
const FAILED = "That did not work. Try again.";

/** The words to show for a job that ended in anything but `done`; the pod's own words when it gave some. */
export function jobFailure(outcome: PodJobOutcome): string {
  if (outcome.status === "missing") {
    return "Your assistant's answer was lost. Try again.";
  }
  if (outcome.status === "timeout") {
    return outcome.detail ?? TOO_SLOW;
  }
  return outcome.detail ?? ERROR_WORDS[outcome.error ?? ""] ?? (outcome.error === "timeout" ? TOO_SLOW : FAILED);
}
