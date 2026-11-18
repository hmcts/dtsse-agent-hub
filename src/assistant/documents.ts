import type { TicketTool } from "./github.ts";

/**
 * A conversation's documents: any number of them, each of one kind. A `document` can go to the person's ticket tool
 * and to Confluence; a `ticket` is a Jira backlog item or a GitHub issue and goes only to the ticket tool; a
 * `confluence` page goes only to Confluence. The store is `artefact-store.ts`; see "Artefacts" in docs/agent-api.md.
 */

export const DOCUMENT_KINDS = ["document", "ticket", "confluence"] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export const UNTITLED_DOCUMENT = "Untitled document";

/** Where a document of `kind` can be exported to. */
export function documentExports(kind: DocumentKind): { ticket: boolean; confluence: boolean } {
  return { ticket: kind !== "confluence", confluence: kind !== "ticket" };
}

/**
 * The conversation's primary document: its oldest of kind `document`, which `/api/agent/{id}/artefact` and every client
 * older than several documents read and write. `documents` is oldest first, as `listDocuments` answers it.
 */
export function primaryDocument<T extends { kind: string }>(documents: readonly T[]): T | undefined {
  return documents.find((document) => document.kind === "document");
}

/** What the switcher calls a document: a ticket or a Confluence page says so ahead of its title. */
export function documentLabel(kind: DocumentKind, title: string | null, tool: TicketTool): string {
  const name = title ?? UNTITLED_DOCUMENT;
  if (kind === "ticket") {
    return `${tool === "github" ? "GitHub" : "Jira"}: ${name}`;
  }
  return kind === "confluence" ? `Confluence: ${name}` : name;
}

/**
 * Refused for a conversation whose pod runs a client older than `items`, which reads only the primary document: a
 * second document, or one of another kind, would be one its session never sees, and an export of anything but the
 * primary would read the primary instead.
 */
export const ITEMS_CREATE_REFUSED = "your assistant needs an update to hold more than one document; it gets one the next time it restarts";
export const ITEMS_EXPORT_REFUSED = "your assistant needs an update to export this document; it gets one the next time it restarts";
