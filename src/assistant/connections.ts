import type { CredentialKind } from "../credentials/names.ts";
import type { CredentialStatus } from "../credentials/store.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import type { LoginView } from "../virtual-agents/logins.ts";
import type { ConnectionsAsk } from "./onboarding.ts";

/**
 * The sign-ins the hub holds for a person, as the Assistant's settings show them, and the prompt the sidebar shows
 * when one of them needs the person. Pure: the dialog renders what `connections` returns.
 */

/** What settings needs to list the person's sign-ins, or why it cannot. */
export interface ConnectionsData {
  /** How this assistant's agents reach Claude, which both the model-access row and Azure's wording follow. */
  route: ModelRoute;
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
  assistant: { modelRoute: ModelRoute; needed: CredentialKind[]; optional: CredentialKind[]; logins: LoginView[] },
  credentials: { available: true; statuses: CredentialStatus[] } | { available: false; reason: string }
): ConnectionsData {
  return {
    route: assistant.modelRoute,
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
  azure: { name: "Azure", initial: "Az", desc: "Your HMCTS account, for pipelines and environments (optional)", paste: null },
  atlassian: { name: "Atlassian", initial: "A", desc: "Jira tickets and Confluence pages (optional)", paste: null },
  jenkins: { name: "Jenkins", initial: "J", desc: "Builds and pipelines on Jenkins (optional)", paste: "Jenkins API token" },
  claude: { name: "Claude", initial: "C", desc: "Your Claude licence", paste: "Claude token" },
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
 * What the Azure sign-in is for, which is not the same thing on both routes: on `gateway` it is what the person's
 * agents reach Claude on, so `neededCredentials` names it and the connections banner asks for it, and calling it
 * optional there would contradict the ask. A table over the whole union, so a route added without an answer does not
 * build, and the `own-licence` wording is `CONNECTORS`'s own rather than a second copy of it.
 */
const AZURE_DESC: Readonly<Record<ModelRoute, string>> = {
  gateway: "Your HMCTS account, which your agents reach Claude on, as well as your pipelines and environments",
  "own-licence": CONNECTORS.azure.desc
};

/**
 * One connection in the Assistant's words, for a person on this route. The seam every surface reads `CONNECTORS`
 * through, because the table is flat and one of its entries is not: a surface reading the entry directly would word
 * Azure as optional beside an ask that needs it.
 */
export function connectorFor(kind: ConnectionKind, route: ModelRoute): Connector {
  return kind === "azure" ? { ...CONNECTORS.azure, desc: AZURE_DESC[route] } : CONNECTORS[kind];
}

/**
 * Where one sign-in stands. `checklistState` answers "login" for any sign-in a pod has relayed, whether or not one is
 * already stored, so that answer splits in three here: `finishing` is a code the person has already sent back and the
 * pod has yet to collect, `refreshing` a relayed sign-in with a credential behind it that the pod has not failed to
 * use, since `startLogin` deletes nothing, and `signing-in` one with nothing behind it. Its "waiting" splits by what
 * became of the last sign-in, so a lapsed one reads as lapsed rather than as never set up.
 */
export type ConnectionState = "connected" | "finishing" | "refreshing" | "signing-in" | "expired" | "failed" | "waiting";

/** What `checklistState` answers, named here so this module does not import the checklist that owns those states. */
export type ChecklistAnswer = "stored" | "login" | "waiting";

/**
 * Each state in the Assistant's words, for its connection rows and its settings dialog. The hub's own agent page
 * words the same states differently, in `SIGN_IN_DETAIL`, because its cards are the owner's view of one agent's
 * credentials rather than a person's view of their sign-ins: there "waiting" means waiting for the agent to ask.
 */
export const CONNECTION_DETAILS: Record<ConnectionState, string> = {
  connected: "Connected",
  finishing: "Finishing signing in",
  refreshing: "Waiting for you to sign in again",
  "signing-in": "Waiting for you",
  expired: "Sign-in expired",
  failed: "Last sign-in failed",
  waiting: "Not connected"
};

/**
 * What each state means for the two questions every surface asks of it, as a table over the whole union rather than a
 * chain of comparisons: a state added without an answer here does not build, which is the same guarantee the wording
 * tables give. A predicate that fell through to `false` would answer "nothing to do" on every surface for a state
 * nobody had thought about, and no test over login shapes would see it.
 *
 * `lapsed` is a sign-in that worked once and has stopped, as against one nobody ever set up.
 *
 * `needsPerson` is a sign-in that is nobody's to finish but theirs: a relayed code only they can enter or paste, or
 * one that lapsed before they did. A relayed sign-in counts whether or not a credential sits behind it — a pod relays
 * a code precisely because it cannot get past this without the person, so `refreshing` is a wait on them and not a
 * renewal going on by itself. `finishing` is the one relayed sign-in that is not: they have sent the code back and
 * the pod has yet to collect it, so asking again would be asking for what they have done.
 *
 * Every surface that prompts is built on `needsPerson`, and a prompt for a state with nothing to press is the fault
 * this exists to remove rather than report. `offeredConnections` is what keeps that true: it gives the screen a row
 * for each of these, and leaves out the one lapsed sign-in with no way back.
 */
const MEANING: Record<ConnectionState, { lapsed: boolean; needsPerson: boolean }> = {
  connected: { lapsed: false, needsPerson: false },
  finishing: { lapsed: false, needsPerson: false },
  refreshing: { lapsed: false, needsPerson: true },
  "signing-in": { lapsed: false, needsPerson: true },
  expired: { lapsed: true, needsPerson: true },
  failed: { lapsed: true, needsPerson: true },
  waiting: { lapsed: false, needsPerson: false }
};

/** Every state a sign-in can be in, so a list of them is the compiler's rather than a second copy of the union. */
export const CONNECTION_STATES = Object.keys(MEANING) as ConnectionState[];

export function hasLapsed(state: ConnectionState): boolean {
  return MEANING[state].lapsed;
}

export function needsPerson(state: ConnectionState): boolean {
  return MEANING[state].needsPerson;
}

/**
 * Whether the code the person pasted is still there for the pod to collect. The column being set is not that:
 * `takePastedCode` hands over nothing once the deadline has passed and leaves the column alone.
 */
export function codeCollectable(login: LoginView | undefined, now: number): boolean {
  return login?.codeWaitingUntil != null && Date.parse(login.codeWaitingUntil) > now;
}

/** What ordering a sign-in against its credential takes: when the credential was saved, and whether one was. */
export type StoredCredential = Pick<CredentialStatus, "stored" | "updatedAt"> | undefined;

/**
 * Whether the last sign-in for a kind is over without having replaced the credential it was for, which is how the hub
 * tells a credential that works from one a pod has just failed to use.
 *
 * A sign-in is over and unsuccessful in two ways, and both count. A pod reports `expired` or `failed`. Or its code
 * simply runs out: `failLogin` and `failForAzureAccount` are the only writers of those two states and both need a
 * pod's report, and no sweep touches `virtual_agent_login` — so a pod that stops before reporting leaves a `pending`
 * row with its expiry in the past for ever, and reading that as a sign-in still in flight reads the fault as fine.
 *
 * The credential outlives either: `startLogin` and `failLogin` leave it alone, and a pod overwrites it only once a
 * new sign-in succeeds — the one exception being an Azure sign-in as somebody else's account, which `completeLogin`
 * deletes outright. So the two timestamps are the whole of the evidence, and the rule is that the later write is the
 * newer fact: a sign-in that ended after the credential was last saved is a pod that could not use what is stored,
 * and one that ended before the save is the failure the save is the answer to.
 *
 * It is the later *write*, not the later attempt, and the two part company in one narrow case: a pod relays a code,
 * the person pastes their own value instead, and the pod then reports that first code expired. The report is newer
 * than the save but is about an attempt older than it, so the row reads as lapsed and offers its box again. Nothing
 * better is available — the login row carries when its state was written, and `createdAt` is the first relay for
 * that kind rather than the current one — and the state recovers as soon as the pod signs in or the person pastes
 * again, so the cost is one row asking for something it already has.
 */
export function lapsedSinceStored(login: LoginView | undefined, stored: StoredCredential, now: number): boolean {
  if (login === undefined || login.state === "completed" || (login.state === "pending" && Date.parse(login.expiresAt) > now)) {
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
  /** Whether a value is saved, which signing in again would delete; true of a lapsed sign-in as much as a working one. */
  stored: boolean;
}

/**
 * A stored credential is connected only while nothing newer says otherwise. `lapsedSinceStored` is that newer thing,
 * and without it a sign-in the pod has reported dead reads as a tick on every surface — which is the state the
 * person cannot act on, because nothing they can see says anything is wrong.
 */
export function connectionState(checklist: ChecklistAnswer, login: LoginView | undefined, stored: StoredCredential, now: number): ConnectionState {
  if (checklist === "login") {
    if (codeCollectable(login, now)) {
      // Their part is done: the code they pasted is sealed for the pod to collect, and nothing is waiting on them.
      return "finishing";
    }
    // A pod relays a fresh sign-in without deleting the credential it already has, so one already stored still works
    // while the person completes it. Only a sign-in with nothing behind it is waiting on them. Either way it is a
    // wait on them: `needsPerson` is what asks that, and it answers yes to both.
    return stored?.stored === true ? "refreshing" : "signing-in";
  }
  // `startLogin` overwrites the row it relays over, so the one row is the last word on this kind, and a credential a
  // sign-in lapsed over is the one the pod could not use.
  if (stored?.stored === true && !lapsedSinceStored(login, stored, now)) {
    return "connected";
  }
  if (login === undefined || login.state === "completed") {
    return "waiting";
  }
  // A `pending` row here is one whose code ran out: `checklistState` answers "login" for as long as it is live.
  return login.state === "failed" ? "failed" : "expired";
}

/**
 * One row per sign-in `data.kinds` asks for, in that order, leaving out anything that is not a sign-in. `checklist`
 * is `checklistState` from the onboarding checklist, passed in so the two views cannot drift apart.
 *
 * `now` is given to both halves of the answer from here rather than closed over by the caller, so there is one clock
 * behind them. Two would be a row saying a code is waiting beside one saying the credential still works.
 *
 * Credentials the hub cannot read tell us nothing about any of them, so there are no rows: listing every sign-in as
 * not connected would be a row of wrong answers, and would raise a warning nobody can act on.
 */
export function connections(
  data: ConnectionsData | undefined,
  checklist: (stored: boolean, login: LoginView | undefined, now: number) => ChecklistAnswer,
  now: number
): Connection[] {
  if (data === undefined || data.unavailable !== null) {
    return [];
  }
  return data.kinds.filter(isConnection).map((kind) => {
    const status = data.statuses.find((candidate) => candidate.kind === kind);
    const login = data.logins.find((candidate) => candidate.kind === kind);
    const state = connectionState(checklist(status?.stored === true, login, now), login, status, now);
    return {
      kind,
      ...connectorFor(kind, data.route),
      state,
      detail: CONNECTION_DETAILS[state],
      accountLabel: status?.accountLabel ?? null,
      stored: status?.stored === true
    };
  });
}

/**
 * How the person's agents reach Claude, as a row of the Connections list. Named as the sign-in it stands in for is,
 * so the section reads the same on both routes, and worded by the route, because the two reach it differently.
 */
export interface ModelAccess {
  name: string;
  /** The letters the list shows in place of a logo. */
  initial: string;
  desc: string;
  state: ConnectionState;
  detail: string;
}

/**
 * The model-access row each route needs derived, and the sign-in its state is read from, or `null` for a route whose
 * model credential is a row of the list already. A table over the whole union, so a route added without an answer
 * does not build rather than quietly saying nothing about Claude.
 *
 * The name and the letters are the Claude connector's, so the row reads the same whichever route the person is on and
 * there is one copy of both.
 */
const MODEL_ACCESS: Readonly<Record<ModelRoute, { behind: ConnectionKind; row: Omit<ModelAccess, "state" | "detail"> } | null>> = {
  gateway: {
    behind: "azure",
    row: { name: CONNECTORS.claude.name, initial: CONNECTORS.claude.initial, desc: "Through the HMCTS AI Gateway, on your Azure sign-in" }
  },
  "own-licence": null
};

/**
 * The row saying how this person's agents reach Claude, where no credential of theirs is what gets them there, or
 * `null` where one is and `connections` has the row already.
 *
 * On `gateway` there is no model credential at all — the pod mints a gateway token from the owner's Azure sign-in —
 * so without this the Connections section says nothing about Claude or the gateway, which is the first thing people
 * look for in it.
 *
 * Its state is read from the row of the credential behind it rather than from the statuses again, so the two cannot
 * disagree and there is no second clock between them. No such row — which is what the hub failing to read somebody's
 * credentials leaves — means no claim here either, for the same reason `connections` lists nothing then.
 *
 * It is not a `Connection` and has no kind, so `offersConnect`, `connectionsWarning` and `signInPrompt` cannot be
 * asked about it. That is the point: the credential's own row carries the action and raises the prompt, and a second
 * prompt for one sign-in, on a row with nothing to press, is the fault `offeredConnections` exists to prevent.
 */
export function modelAccess(route: ModelRoute, list: readonly Connection[]): ModelAccess | null {
  const derived = MODEL_ACCESS[route];
  if (derived === null) {
    return null;
  }
  const behind = list.find((row) => row.kind === derived.behind);
  return behind === undefined ? null : { ...derived.row, state: behind.state, detail: behind.detail };
}

/**
 * Whether the derived model-access row goes after the row at this place in the list: after the first, which is GitHub
 * on both routes, since that is where the `own-licence` route's Claude token has always been. Asked here rather than
 * by each surface, so Claude cannot come second on one screen and first on another.
 */
export function modelAccessAfter(index: number): boolean {
  return index === 0;
}

/**
 * The sign-ins the assistant makes only when the person asks for one, from the Connections section of its settings.
 * Azure lets it act as them with `az`, which nothing in a chat waits for, so it is in the background as a Jenkins token
 * is: nothing prompts for it, and a sign-in of it is raised as an ask only while the code they asked for is live. One
 * that lapsed is left to that section, where it says so and offers to connect again, rather than being put back in
 * front of somebody who may have changed their mind.
 *
 * On the `gateway` route it is also the model credential, so `neededCredentials` names it and the connections banner
 * asks for it — but it is still signed in to on request, because the sign-in is the same device code either way.
 */
export const ON_REQUEST: readonly CredentialKind[] = ["azure"];

/** Whether the assistant signs in to `kind` only when the person asks it to. */
export function signsInOnRequest(kind: CredentialKind): boolean {
  return ON_REQUEST.includes(kind);
}

/** Whether a sign-in in `state` is one the Assistant asks the person about, rather than leaving it to settings. */
function asksAbout(kind: CredentialKind, state: ConnectionState): boolean {
  return needsPerson(state) && !(signsInOnRequest(kind) && hasLapsed(state));
}

/**
 * Whether the settings row offers to connect this sign-in: one made on request that is not connected and is not
 * waiting on a code already. The connect restarts the assistant so its pod relays the sign-in, and a code that is live
 * is already the thing to do.
 */
export function offersConnect(row: Pick<Connection, "kind" | "state">): boolean {
  return signsInOnRequest(row.kind) && (row.state === "waiting" || hasLapsed(row.state));
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
 * Whether a sign-in of this kind that is over and unsuccessful has a way back the hub will take.
 *
 * One the assistant makes for itself always has: `reconnectSignIn` accepts a `SignInKind`, and the kinds with no
 * `paste` are exactly those — which is `CONNECTORS`'s own test, "should ask the person to paste exactly the
 * connections their assistant cannot sign in to itself", and the reason this can read `paste` rather than importing
 * the server module that owns `SIGN_IN_KINDS`. It restarts the pod so it relays a fresh code. Anything the person
 * pastes has a way back only for a credential their
 * assistant uses, because `saveCredential` is route-aware — it refuses a Claude token from somebody whose agents do
 * not run on their own licence. So a lapsed Claude sign-in relayed to a gateway-route person has no way back at all:
 * the only control for it is a box whose save is refused, and nothing ever clears the login row, since `startLogin`
 * overwrites only on a new relay and the two states that end one need a pod's report.
 *
 * That is the one state an ask must never name — an ask it cannot satisfy and cannot dismiss — so it is left off the
 * screen as well, and the two cannot drift because this is the only place the question is asked.
 */
export function canSignInAgain(kind: CredentialKind, uses: readonly CredentialKind[]): boolean {
  return isConnection(kind) && (CONNECTORS[kind].paste === null || uses.includes(kind));
}

/**
 * The connections the getting-ready screen lists, and the set the banner that opens it names from: every one the
 * assistant needs, every one its pod has asked the person for and not finished, and the optional one it offers
 * unasked. Needed first, so the ask reads in the order the banner names it in, and each kind once however many of the
 * three it is.
 *
 * Every live sign-in is here whatever kind it is for, and not only the ones some list expected. A pod relays a
 * sign-in through `startLogin`, which takes any `CredentialKind` — `claude` is reachable today and is in neither
 * `neededCredentials` nor `OPTIONAL_CREDENTIALS` — so a live sign-in this left out would be an ask with nothing to
 * act on: the bar sitting at 55% under "Waiting for you to connect your accounts…", every row shown reading as
 * connected, and no way to clear it. Which kinds a pod relays today is decided in another repo, and this must not
 * depend on that answer. Completing one never goes through a credential the hub has to accept on their behalf — the
 * code goes back to the pod — so there is always something to do about it.
 *
 * One that is over is here only while `canSignInAgain`, which is the other half of the same rule: the row is what the
 * ask points at, so a kind with no way back belongs on neither. Nor is one made `ON_REQUEST`, whose way back is in
 * settings. Over is `now`'s to decide and not only the pod's,
 * because a code that ran out is over whether or not its pod lived long enough to say so.
 */
export function offeredConnections(
  assistant: {
    modelRoute: ModelRoute;
    needed: readonly CredentialKind[];
    optional: readonly CredentialKind[];
    logins: readonly LoginView[];
  },
  now: number
): OfferedConnection[] {
  const uses = [...assistant.needed, ...assistant.optional];
  const live = (login: LoginView) => login.state === "pending" && Date.parse(login.expiresAt) > now;
  const asked = assistant.logins
    .filter((login) => live(login) || (login.state !== "completed" && !signsInOnRequest(login.kind) && canSignInAgain(login.kind, uses)))
    .map((login) => login.kind);
  const unasked = assistant.optional.filter((kind) => OFFERED_OPTIONAL.includes(kind));
  const rows: OfferedConnection[] = [];
  for (const kind of [...assistant.needed, ...asked, ...unasked]) {
    if (isConnection(kind) && !rows.some((row) => row.kind === kind)) {
      rows.push({ kind, connector: connectorFor(kind, assistant.modelRoute) });
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
 * The sign-ins the cog prompts about when the person has never set one up. Model access is left out: the connections
 * banner asks for it for as long as it is missing, which is as long as this would. A Jenkins token and an Azure
 * sign-in are nobody's requirement, and never setting Atlassian up is a choice — a badge nobody can ever clear
 * teaches people to ignore the one that matters.
 */
export const PROMPTED_WHEN_MISSING: readonly CredentialKind[] = ["github"];

/**
 * Whether a row is worth the person's attention.
 *
 * Anything their assistant has asked them for and they have not finished, whatever kind it is. Being stored is what
 * silences the connections banner, so a stored credential whose sign-in has since lapsed is a state no other surface
 * says anything about — which is exactly the one the badge is for, and leaving a kind out of it by name is how
 * Claude and Jenkins came to have no badge at all once their value was stored.
 *
 * `asksAbout` and nothing wider, so the badge cannot point at a prompt that is not raised: the cog says to close the
 * dialog and look above the chats, and `signInPrompt` is what is there. A `finishing` sign-in raises neither, and
 * nor does a lapsed one made `ON_REQUEST`.
 */
function needsAttention(row: Connection): boolean {
  return asksAbout(row.kind, row.state) || (PROMPTED_WHEN_MISSING.includes(row.kind) && row.state === "waiting");
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
 * Every kind on the list is named, needed or optional, because what the person has to do is the same for all of them
 * and the banner is the one thing that says a code is waiting. `offeredConnections` is what the list comes from, and
 * so is what keeps a sign-in with no way back off it. `connectionsPrompt`'s `connect` covers a needed credential
 * never stored at all, so this is only consulted once that has nothing to ask.
 *
 * A live code and a lapsed sign-in are worded apart, because they are different things to do — type this, or ask for
 * another — and because a message that read the same for both would be read out once and then not again when the
 * thing to do changed.
 */
export function signInPrompt(list: readonly Connection[]): ConnectionsPrompt | null {
  const asking = list.filter((row) => asksAbout(row.kind, row.state));
  if (asking.length === 0) {
    return null;
  }
  const names = inWords(asking.map((row) => row.name));
  return {
    label: "Sign in",
    message: asking.some((row) => !hasLapsed(row.state))
      ? `Your assistant is waiting for you to sign in to ${names}.`
      : `Your assistant could not sign in to ${names}, and is not asking again by itself.`,
    action: "Show the sign-in"
  };
}
