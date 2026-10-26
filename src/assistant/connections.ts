import type { CredentialKind } from "../credentials/names.ts";
import type { CredentialStatus } from "../credentials/store.ts";
import type { LoginView } from "../virtual-agents/logins.ts";
import type { ConnectionsAsk } from "./onboarding.ts";

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
  /**
   * What the person pastes to connect it, or `null` when their assistant signs in for them and relays a code. The
   * screen offers a field for the first and a note about the sign-in to come for the second, so getting this wrong
   * is a row with nothing on it that connects anything.
   */
  paste: string | null;
}

/**
 * Every kind of credential in the Assistant's words, or `null` for one that is not a connection. The Assistant's
 * only copy of this: the getting-ready screen and the settings dialog both read it, and a second list behind one of
 * them drifts from the wording of the ask that sent the person there.
 *
 * Total over `CredentialKind` so the compiler, and not a person reading a screen, finds the next kind added: a
 * missing entry here is a credential the hub can wait for and no surface can show.
 */
export const CONNECTORS = {
  github: { name: "GitHub", initial: "G", desc: "Read repositories and open pull requests", paste: null },
  azure: { name: "Azure", initial: "Az", desc: "Your HMCTS account, for pipelines and environments", paste: null },
  atlassian: { name: "Atlassian", initial: "A", desc: "Jira tickets and Confluence pages (optional)", paste: null },
  jenkins: { name: "Jenkins", initial: "J", desc: "Builds and pipelines on Jenkins (optional)", paste: "Jenkins API token" },
  claude: { name: "Claude", initial: "C", desc: "Your Claude licence", paste: "Claude token" },
  bedrock: { name: "AI model access", initial: "AI", desc: "Your Amazon Bedrock API key", paste: "Bedrock API key" },
  // Neither is a sign-in: both are kept beside them because they may hold private context, and there is nothing to
  // connect for either, so no surface offers a row for them.
  claude_md: null,
  git_identity: null
} as const satisfies Record<CredentialKind, Connector | null>;

/** The kinds `CONNECTORS` words, so reading one of those needs no cast and no fallback for a kind it does not. */
export type ConnectionKind = { [K in CredentialKind]: (typeof CONNECTORS)[K] extends null ? never : K }[CredentialKind];

/**
 * A kind is a connection when it is something the person signs in to. Their CLAUDE.md and their git identity are
 * kept beside the sign-ins but are neither, so settings never shows them as one.
 */
export function isConnection(kind: CredentialKind): kind is ConnectionKind {
  return Object.hasOwn(CONNECTORS, kind) && CONNECTORS[kind] !== null;
}

/**
 * Where one sign-in stands. `checklistState` answers "login" for any sign-in a pod has relayed, whether or not one is
 * already stored, so that answer splits in two here: `refreshing` is a relayed sign-in with a credential behind it
 * that the pod has not failed to use, since `startLogin` deletes nothing. Its "waiting" splits by what became of the
 * last sign-in, so a lapsed one reads as lapsed rather than as never set up.
 */
export type ConnectionState = "connected" | "refreshing" | "signing-in" | "expired" | "failed" | "waiting";

/** What `checklistState` answers, named here so this module does not import the checklist that owns those states. */
export type ChecklistAnswer = "stored" | "login" | "waiting";

/** Each state in words. Exported so every surface saying where a sign-in stands says it the same way. */
export const CONNECTION_DETAILS: Record<ConnectionState, string> = {
  connected: "Connected",
  refreshing: "Waiting for you to sign in again",
  "signing-in": "Waiting for you",
  expired: "Sign-in expired",
  failed: "Last sign-in failed",
  waiting: "Not connected"
};

/** A sign-in that worked once and has stopped working, as opposed to one nobody ever set up. */
export function hasLapsed(state: ConnectionState): boolean {
  return state === "expired" || state === "failed";
}

/**
 * A sign-in that is nobody's to finish but the person's: a relayed code only they can enter or paste, or one that
 * lapsed before they did. A relayed sign-in counts whether or not a credential sits behind it — a pod relays a code
 * precisely because it cannot get past this without the person, so `refreshing` is a wait on them and not a renewal
 * going on by itself.
 */
export function needsPerson(state: ConnectionState): boolean {
  return state === "refreshing" || state === "signing-in" || hasLapsed(state);
}

/** What ordering a sign-in against its credential takes: when the credential was saved, and whether one was. */
export type StoredCredential = Pick<CredentialStatus, "stored" | "updatedAt"> | undefined;

/**
 * Whether the last sign-in for a kind lapsed with nothing newer to contradict it, which is how the hub tells a
 * credential that works from one a pod has just failed to use.
 *
 * Nothing deletes a credential when its sign-in fails: `startLogin` and `failLogin` leave it alone, and a pod
 * overwrites it only once a new sign-in succeeds. So the two timestamps are the whole of the evidence — a sign-in
 * that ended `expired` or `failed` after the credential was last saved is a pod that could not use what is stored,
 * and a sign-in that lapsed before the save is the failure the stored value is the answer to.
 */
export function lapsedSinceStored(login: LoginView | undefined, stored: StoredCredential): boolean {
  if (login === undefined || (login.state !== "expired" && login.state !== "failed")) {
    return false;
  }
  const storedAt = stored?.stored === true ? stored.updatedAt : null;
  return storedAt === null || Date.parse(login.updatedAt) > Date.parse(storedAt);
}

export interface Connection extends Connector {
  kind: CredentialKind;
  state: ConnectionState;
  /** `state` in words, for the person to read beside the name. */
  detail: string;
  /** The account the sign-in is for, when the hub recorded one. */
  accountLabel: string | null;
}

/**
 * A stored credential is connected only while nothing newer says otherwise. `lapsedSinceStored` is that newer thing,
 * and without it a sign-in the pod has reported dead reads as a tick on every surface — which is the state the
 * person cannot act on, because nothing they can see says anything is wrong.
 */
export function connectionState(checklist: ChecklistAnswer, login: LoginView | undefined, stored: StoredCredential): ConnectionState {
  if (checklist === "login") {
    // A pod relays a fresh sign-in without deleting the credential it already has, so one already stored still works
    // while the person completes it. Only a sign-in with nothing behind it is waiting on them. Either way it is a
    // wait on them: `needsPerson` is what asks that, and it answers yes to both.
    return stored?.stored === true ? "refreshing" : "signing-in";
  }
  // `startLogin` overwrites the row it relays over, so a lapsed sign-in is the pod's last word on this kind, and a
  // credential it lapsed over is the one the pod could not use.
  const lapsed = login !== undefined && lapsedSinceStored(login, stored);
  if (stored?.stored === true && !lapsed) {
    return "connected";
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
    const stored = status?.stored === true;
    const state = connectionState(checklist(stored, login), login, status);
    return { kind, ...CONNECTORS[kind], state, detail: CONNECTION_DETAILS[state], accountLabel: status?.accountLabel ?? null };
  });
}

/**
 * The one optional connection the Assistant offers unasked. A Jenkins API token is an engineer's thing, and the
 * place for it is the hub's own credentials page rather than in front of somebody who came to start a chat.
 */
export const OFFERED_OPTIONAL: readonly CredentialKind[] = ["atlassian"];

/** One row of the getting-ready screen: the kind, and the Assistant's words for it. */
export interface OfferedConnection {
  kind: ConnectionKind;
  connector: Connector;
}

/**
 * The connections the getting-ready screen lists: every one the assistant needs, every one its pod has stopped to ask
 * the person for, and the optional one it offers unasked. Needed first, so the ask reads in the order the banner
 * names it in, and each kind once however many of the three it is.
 *
 * Every pending sign-in is here whatever kind it is for, and not only the ones some list expected. A pod relays a
 * sign-in through `startLogin`, which takes any `CredentialKind` and puts the assistant in `awaiting_login` for it —
 * so a sign-in this screen left out would be an ask with nothing on the screen to act on: the bar sitting at 55%
 * under "Waiting for you to connect your accounts…", every row shown reading as connected, and no way to clear it.
 * Which kinds a pod relays today is decided in another repo, and this must not depend on that answer.
 *
 * A pending sign-in whose code has run out is asked about too, and no clock is needed to decide it: the assistant
 * stays `awaiting_login` until its pod reports its next step, so the row is still the only thing to act on.
 */
export function offeredConnections(assistant: {
  needed: readonly CredentialKind[];
  optional: readonly CredentialKind[];
  logins: readonly LoginView[];
}): OfferedConnection[] {
  const asked = assistant.logins.filter((login) => login.state === "pending").map((login) => login.kind);
  const unasked = assistant.optional.filter((kind) => OFFERED_OPTIONAL.includes(kind));
  const rows: OfferedConnection[] = [];
  for (const kind of [...assistant.needed, ...asked, ...unasked]) {
    if (isConnection(kind) && !rows.some((row) => row.kind === kind)) {
      rows.push({ kind, connector: CONNECTORS[kind] });
    }
  }
  return rows;
}

/** "A", "A and B", "A, B and C". */
export function inWords(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export interface ConnectionsPrompt {
  /** The banner's accessible name, so which of the two it is does not depend on reading the sentence. */
  label: string;
  message: string;
  /** What the button that opens the getting-ready screen is called. */
  action: string;
}

/**
 * What the Assistant's connections banner says, or `null` when it has nothing to say. Which of the three it is is
 * `connectionsAsk`'s answer, from every credential the hub holds; this only words it, from the statuses the
 * connections screen was given.
 *
 * A `connect` names the connections rather than counting them: "two connections" tells nobody what to go and get.
 * Anything with no wording of its own is named by its kind, so a credential added to a route before this list gets a
 * row still reads as something rather than disappearing from the ask. And when there is nothing to name it asks in
 * general rather than going quiet.
 *
 * An `unknown` is the opposite message, and the one thing it must never read as is the first: nothing is missing as
 * far as anybody knows, the hub simply cannot see the sign-ins, and there is nothing for the person to do. Telling
 * someone who has connected everything to connect it again is the mistake these two wordings exist to keep apart.
 */
export function connectionsPrompt(ask: ConnectionsAsk, needed: readonly CredentialKind[], stored: ReadonlySet<CredentialKind>): ConnectionsPrompt | null {
  if (ask === "done") {
    return null;
  }
  if (ask === "unknown") {
    return {
      label: "Your sign-ins cannot be checked",
      message:
        "Your sign-ins cannot be checked just now. Whatever you have already connected is still connected, and there is nothing for you to set up again.",
      action: "Show progress"
    };
  }
  const names = needed.filter((kind) => !stored.has(kind)).map((kind) => CONNECTORS[kind]?.name ?? kind);
  return {
    label: "Connect your accounts",
    message: `Your assistant needs ${names.length === 0 ? "you to connect your accounts" : inWords(names)} before it can work for you.`,
    action: "Connect accounts"
  };
}

/**
 * The sign-ins the cog prompts about, and when. Model access is left out of both on purpose: nobody can use the
 * Assistant at all without it, and the connections banner asks for it until it is there.
 *
 * A needed sign-in is prompted about whenever it is not connected, because the person has to have it. An optional one
 * is prompted about once their assistant has asked them for it — a code it is holding for them, or one that lapsed
 * unused — and not before: never setting Atlassian up is a choice, and a badge nobody can ever clear teaches people
 * to ignore the one that matters.
 */
export const PROMPTED_CONNECTIONS: readonly CredentialKind[] = ["github", "azure"];
export const PROMPTED_WHEN_ASKED: readonly CredentialKind[] = ["atlassian"];

/** Whether a row is worth the person's attention, by the rule its kind is prompted under. */
function needsAttention(row: Connection): boolean {
  if (PROMPTED_CONNECTIONS.includes(row.kind)) {
    return row.state !== "connected";
  }
  return PROMPTED_WHEN_ASKED.includes(row.kind) && needsPerson(row.state);
}

/**
 * The prompt the cog carries, or `null` when nothing needs the person. It names the sign-ins rather than saying the
 * Assistant is broken, because none of these stops someone chatting and Atlassian is optional besides.
 */
export function connectionsWarning(list: readonly Connection[]): string | null {
  const names = list.filter(needsAttention).map((row) => row.name);
  if (names.length === 0) {
    return null;
  }
  return `${inWords(names)} ${names.length === 1 ? "needs" : "need"} your attention`;
}

/**
 * What the Assistant says about a sign-in its pod is holding for the person, or `null` when it is holding none.
 *
 * Read from the sign-ins rather than from how far the assistant has got, because the assistant does not stay stopped
 * for this: `failLogin` takes it out of `awaiting_login` as the last code dies, so by the time the codes have run out
 * the only record of the ask is the login row. A surface keyed to the status has nothing left to show.
 *
 * Every kind is named, needed or optional, because what the person has to do is the same for all of them and the
 * banner is the one thing that says a code is waiting. `connectionsPrompt`'s `connect` covers the case where a needed
 * credential was never stored at all, so this is only ever consulted once that has nothing to ask.
 */
export function signInPrompt(list: readonly Connection[]): ConnectionsPrompt | null {
  const names = list.filter((row) => needsPerson(row.state)).map((row) => row.name);
  if (names.length === 0) {
    return null;
  }
  return {
    label: "Sign in again",
    message: `Your assistant is waiting for you to sign in to ${inWords(names)}.`,
    action: "Show the sign-in"
  };
}
