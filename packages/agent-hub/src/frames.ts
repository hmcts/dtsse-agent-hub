// How the bridge reads a `direct` stream event. The stream is untrusted input from a hub that may be older or newer
// than this client, so every field is checked here and anything that does not fit is dropped or left absent.
import { parseModel } from "./assistant/models.ts";
import type { AssistantFrame, AssistantProduct, ConfluenceExportFrame, GithubExportFrame, JiraExportFrame } from "./envelope.ts";
import { GITHUB_OWNER_RE, GITHUB_REPO_RE } from "./github.ts";

// Structural, and every field optional: it is the shape both `directs` and `envelope` read, so a message
// narrowed here fits either without this module choosing one of their author types over the other.
export type DirectEventAuthor = {
  type?: string;
  agent_id?: string | null;
  agent_name?: string | null;
  owner_name?: string | null;
  owner_email?: string | null;
};

/** Exactly the fields of a `direct` event's message that the bridge, the envelopes and `directs` read. */
export type DirectEventMessage = {
  id: string;
  /**
   * `direct` for a message written to this agent, `post` for a board post that tagged it. The two arrive in the same
   * frame, so this is what tells them apart and picks the envelope; absent from no hub that has ever sent one, but
   * optional because the stream is untrusted input.
   */
  kind?: string;
  title?: string | null;
  topics?: string[];
  body: string;
  in_reply_to?: string | null;
  created_at?: string;
  author?: DirectEventAuthor;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (typeof value === "string" || value === null) {
    return value;
  }
  return undefined;
}

function parseAuthor(value: unknown): DirectEventAuthor | undefined {
  const raw = asRecord(value);
  if (!raw) {
    return undefined;
  }
  return {
    type: asOptionalString(raw.type),
    agent_id: asNullableString(raw.agent_id),
    agent_name: asNullableString(raw.agent_name),
    owner_name: asNullableString(raw.owner_name),
    owner_email: asNullableString(raw.owner_email)
  };
}

/**
 * The message on a `direct` stream event, or null when there is none to deliver. The stream is untrusted
 * input and may come from a hub older or newer than this client, so a missing body is delivered as an empty
 * one rather than dropped: a message the bridge drops is never acked, and the hub replays it for ever.
 */
export function parseDirectEventMessage(value: unknown): DirectEventMessage | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  let id = "";
  if (typeof raw.id === "string") {
    id = raw.id;
  } else if (typeof raw.id === "number") {
    id = String(raw.id);
  }
  if (!id) {
    return null;
  }
  return {
    id,
    kind: asOptionalString(raw.kind),
    title: asNullableString(raw.title),
    topics: Array.isArray(raw.topics) ? raw.topics.filter((topic): topic is string => typeof topic === "string") : undefined,
    body: typeof raw.body === "string" ? raw.body : "",
    in_reply_to: asNullableString(raw.in_reply_to),
    created_at: asOptionalString(raw.created_at),
    author: parseAuthor(raw.author)
  };
}

/**
 * The `assistant` object on a `direct` frame, or null when the frame carries none. Every field the envelope and
 * the recorded product read is listed here, so a hub that sends one this client does not know about is the only
 * way a field goes missing.
 */
export function parseAssistantFrame(value: unknown): AssistantFrame | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    conversation_id: asOptionalString(raw.conversation_id),
    product: asNullableString(raw.product),
    product_label: asNullableString(raw.product_label),
    model: parseModel(raw.model),
    artefact_version: typeof raw.artefact_version === "number" ? raw.artefact_version : null,
    artefact_updated_by: asNullableString(raw.artefact_updated_by),
    deck_version: typeof raw.deck_version === "number" ? raw.deck_version : null,
    deck_updated_by: asNullableString(raw.deck_updated_by),
    jira_export: parseJiraExportFrame(raw.jira_export),
    github_export: parseGithubExportFrame(raw.github_export),
    confluence_export: parseConfluenceExportFrame(raw.confluence_export),
    // Left as it came: `readAttachments`, at the point of delivery, is what decides which entries this client will
    // fetch and what the envelope says about the rest, so checking them here would only do it twice.
    attachments: raw.attachments
  };
}

const EXPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
const WORD_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A pending Jira export on the frame, or null. Its values go into the `jira export` command the session is told to run, so
 * anything but an id, a project key and plain words is dropped rather than passed on.
 */
export function parseJiraExportFrame(value: unknown): JiraExportFrame | null {
  const raw = asRecord(value);
  if (
    !raw ||
    typeof raw.export_id !== "string" ||
    !EXPORT_ID_RE.test(raw.export_id) ||
    typeof raw.project !== "string" ||
    !PROJECT_RE.test(raw.project) ||
    typeof raw.issue_type !== "string" ||
    !WORD_RE.test(raw.issue_type) ||
    !Array.isArray(raw.labels) ||
    !raw.labels.every((label) => typeof label === "string" && WORD_RE.test(label))
  ) {
    return null;
  }
  return { export_id: raw.export_id, project: raw.project, issue_type: raw.issue_type, labels: raw.labels as string[] };
}

/**
 * A pending GitHub export on the frame, or null. Its values go into the `github export` command the session is told
 * to run, so anything but an id, an `owner/name` repository and a Project's owner and number is dropped rather than
 * passed on. A Project that is not one drops the whole export, since going ahead without it would put the issue
 * somewhere other than where the person asked.
 */
export function parseGithubExportFrame(value: unknown): GithubExportFrame | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.export_id !== "string" || !EXPORT_ID_RE.test(raw.export_id) || typeof raw.repo !== "string" || !GITHUB_REPO_RE.test(raw.repo)) {
    return null;
  }
  // Labels go into the command as one comma-separated flag, so each is a plain word; a list that is not is dropped
  // whole rather than in part, since the issue would otherwise be labelled other than the hub asked.
  const labels = Array.isArray(raw.labels) && raw.labels.every((label) => typeof label === "string" && WORD_RE.test(label)) ? (raw.labels as string[]) : [];
  if (raw.project === undefined || raw.project === null) {
    return { export_id: raw.export_id, repo: raw.repo, labels };
  }
  const project = asRecord(raw.project);
  if (
    !project ||
    typeof project.owner !== "string" ||
    !GITHUB_OWNER_RE.test(project.owner) ||
    !Number.isInteger(project.number) ||
    (project.number as number) < 1 ||
    (project.number as number) > 999_999_999
  ) {
    return null;
  }
  return { export_id: raw.export_id, repo: raw.repo, labels, project: { owner: project.owner, number: project.number as number } };
}

const NUMERIC_ID_RE = /^\d{1,20}$/;

/**
 * A pending Confluence export on the frame, or null. Its values go into the `confluence export` command the session is
 * told to run, so anything but an id and two numeric ids is dropped rather than passed on.
 */
export function parseConfluenceExportFrame(value: unknown): ConfluenceExportFrame | null {
  const raw = asRecord(value);
  if (
    !raw ||
    typeof raw.export_id !== "string" ||
    !EXPORT_ID_RE.test(raw.export_id) ||
    typeof raw.space_id !== "string" ||
    !NUMERIC_ID_RE.test(raw.space_id) ||
    typeof raw.parent_id !== "string" ||
    !NUMERIC_ID_RE.test(raw.parent_id)
  ) {
    return null;
  }
  return { export_id: raw.export_id, space_id: raw.space_id, parent_id: raw.parent_id };
}

/** The recorded product of the last delivery, which only this module writes; null for anything else. */
export function parseAssistantProduct(value: unknown): AssistantProduct | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    product: typeof raw.product === "string" ? raw.product : null,
    product_label: typeof raw.product_label === "string" ? raw.product_label : null
  };
}
