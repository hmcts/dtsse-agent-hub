import type { CredentialKind } from "../credentials/names.ts";
import type { CredentialStatus } from "../credentials/store.ts";
import type { LoginView } from "../virtual-agents/logins.ts";

/**
 * The sign-ins the hub holds for a person, as the Assistant's settings show them, and the prompt the sidebar shows
 * when one of them needs the person. Pure: the dialog renders what `connections` returns.
 */

/** What settings needs to list the person's sign-ins, or why it cannot. */
export interface ConnectionsData {
  /** The sign-ins the person's assistant asks for, needed ones first. */
  kinds: CredentialKind[];
  statuses: CredentialStatus[];
  logins: LoginView[];
  /** Why the hub cannot read their credentials, which is not the same as their having none. */
  unavailable: string | null;
}

/**
 * The sign-ins out of what a page already loaded for the getting-ready screen. Credentials the hub cannot read leave
 * the list empty and say why, so settings never reads as "nothing connected" when it simply does not know.
 */
export function connectionsData(
  assistant: { needed: CredentialKind[]; optional: CredentialKind[]; logins: LoginView[] },
  credentials: { available: true; statuses: CredentialStatus[] } | { available: false; reason: string }
): ConnectionsData {
  return {
    kinds: [...assistant.needed, ...assistant.optional],
    statuses: credentials.available ? credentials.statuses : [],
    logins: assistant.logins,
    unavailable: credentials.available ? null : credentials.reason
  };
}

/** Each sign-in in words for someone who has never configured one. The Assistant's one wording for them. */
export interface Connector {
  name: string;
  /** The letters the dialog shows in place of a logo. */
  initial: string;
  desc: string;
}

export const CONNECTORS: Partial<Record<CredentialKind, Connector>> = {
  github: { name: "GitHub", initial: "G", desc: "Read repositories and open pull requests" },
  azure: { name: "Azure", initial: "Az", desc: "Your HMCTS account, for pipelines and environments" },
  atlassian: { name: "Atlassian", initial: "A", desc: "Jira tickets and Confluence pages (optional)" },
  jenkins: { name: "Jenkins", initial: "J", desc: "Builds and pipelines on Jenkins (optional)" },
  claude: { name: "Claude", initial: "C", desc: "Your Claude licence" },
  bedrock: { name: "AI model access", initial: "AI", desc: "Your Amazon Bedrock API key" }
};

/**
 * A kind is a connection when it is something the person signs in to. Their CLAUDE.md and their git identity are
 * kept beside the sign-ins but are neither, so settings never shows them as one.
 */
export function isConnection(kind: CredentialKind): boolean {
  return CONNECTORS[kind] !== undefined;
}

/**
 * Where one sign-in stands. `connected` and `signing-in` are `checklistState`'s "stored" and "login"; the rest split
 * its "waiting" by what became of the last sign-in, so a lapsed one reads as lapsed rather than as never set up.
 */
export type ConnectionState = "connected" | "signing-in" | "expired" | "failed" | "waiting";

/** What `checklistState` answers, named here so this module does not import the checklist that owns those states. */
export type ChecklistAnswer = "stored" | "login" | "waiting";

const DETAILS: Record<ConnectionState, string> = {
  connected: "Connected",
  "signing-in": "Waiting for you",
  expired: "Sign-in expired",
  failed: "Last sign-in failed",
  waiting: "Not connected"
};

export interface Connection extends Connector {
  kind: CredentialKind;
  state: ConnectionState;
  /** `state` in words, for the person to read beside the name. */
  detail: string;
  /** The account the sign-in is for, when the hub recorded one. */
  accountLabel: string | null;
}

/** A stored credential is connected whatever its last sign-in did, so a stale failure never contradicts the tick. */
export function connectionState(checklist: ChecklistAnswer, login: LoginView | undefined): ConnectionState {
  if (checklist === "stored") {
    return "connected";
  }
  if (checklist === "login") {
    return "signing-in";
  }
  if (login === undefined || login.state === "completed") {
    return "waiting";
  }
  // A `pending` login that `checklistState` did not call a login is one whose code ran out while nobody used it.
  return login.state === "failed" ? "failed" : "expired";
}

/**
 * One row per sign-in `data.kinds` asks for, in that order, leaving out anything that is not a sign-in. `checklist`
 * is `checklistState` from the onboarding checklist, passed in so the two views cannot drift apart.
 *
 * Credentials the hub cannot read tell us nothing about any of them, so there are no rows: listing every sign-in as
 * not connected would be a row of wrong answers, and would raise a warning nobody can act on.
 */
export function connections(data: ConnectionsData | undefined, checklist: (stored: boolean, login: LoginView | undefined) => ChecklistAnswer): Connection[] {
  if (data === undefined || data.unavailable !== null) {
    return [];
  }
  return data.kinds.filter(isConnection).map((kind) => {
    const status = data.statuses.find((candidate) => candidate.kind === kind);
    const login = data.logins.find((candidate) => candidate.kind === kind);
    const state = connectionState(checklist(status?.stored === true, login), login);
    return { kind, ...(CONNECTORS[kind] as Connector), state, detail: DETAILS[state], accountLabel: status?.accountLabel ?? null };
  });
}

/**
 * The sign-ins worth prompting about in the sidebar. Model access is left out on purpose: nobody can use the
 * Assistant at all without it, so the getting-ready screen holds them there until they have it.
 */
export const PROMPTED_CONNECTIONS: readonly CredentialKind[] = ["github", "azure", "atlassian"];

/** "A", "A and B", "A, B and C". */
function inWords(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The prompt the cog carries, or `null` when nothing needs the person. It names the sign-ins rather than saying the
 * Assistant is broken, because none of these stops someone chatting and Atlassian is optional besides.
 */
export function connectionsWarning(list: readonly Connection[]): string | null {
  const names = list.filter((row) => PROMPTED_CONNECTIONS.includes(row.kind) && row.state !== "connected").map((row) => row.name);
  if (names.length === 0) {
    return null;
  }
  return `${inWords(names)} ${names.length === 1 ? "needs" : "need"} your attention`;
}
