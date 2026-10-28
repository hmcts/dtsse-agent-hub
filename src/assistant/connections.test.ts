import { describe, expect, it } from "vitest";
import { checklistState } from "@/components/virtual-agents/OnboardingChecklist";
import { CREDENTIAL_KINDS, type CredentialKind } from "../credentials/names.ts";
import type { CredentialStatus } from "../credentials/store.ts";
import { type ModelRoute, modelRouteFor } from "../viewer/identity.ts";
import { isSignInKind, type LoginState, type LoginView } from "../virtual-agents/logins.ts";
import { neededCredentials, OPTIONAL_CREDENTIALS, optionalCredentials } from "../virtual-agents/views.ts";
import {
  CONNECTION_STATES,
  CONNECTORS,
  type Connection,
  type ConnectionState,
  canSignInAgain,
  codeCollectable,
  connectionState,
  connections,
  connectionsData,
  connectionsPrompt,
  connectionsWarning,
  hasLapsed,
  inWords,
  isConnection,
  lapsedSinceStored,
  needsPerson,
  OFFERED_OPTIONAL,
  ON_REQUEST,
  offeredConnections,
  offersConnect,
  PROMPTED_WHEN_MISSING,
  type StoredCredential,
  signInPrompt,
  signsInOnRequest
} from "./connections.ts";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");

const ROUTES: ModelRoute[] = ["bedrock", "gateway", "own-licence"];

/** When a stored credential was saved, and a sign-in either side of it, so the two can be ordered on purpose. */
const STORED_AT = "2026-10-24T09:00:00.000Z";
const BEFORE_STORED = "2026-10-23T09:00:00.000Z";
const AFTER_STORED = "2026-10-25T11:00:00.000Z";

function status(kind: CredentialKind, stored: boolean, accountLabel: string | null = null): CredentialStatus {
  return { kind, stored, accountLabel, updatedAt: stored ? STORED_AT : null, updatedVia: stored ? "pod" : null };
}

/** What `connectionState` needs of a credential: whether one is stored, and when it was last saved. */
function held(updatedAt: string | null = STORED_AT): StoredCredential {
  return { stored: true, updatedAt };
}

const NONE: StoredCredential = { stored: false, updatedAt: null };

function login(kind: CredentialKind, state: LoginState, expiresAt = new Date(NOW + 600_000).toISOString(), updatedAt = BEFORE_STORED): LoginView {
  return {
    kind,
    prompt: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    expiresAt,
    state,
    updatedAt,
    codeWaitingUntil: null
  };
}

/** A sign-in that lapsed after the credential it was to replace was saved: the credential the pod could not use. */
function lapsed(kind: CredentialKind, state: "expired" | "failed" = "expired"): LoginView {
  return login(kind, state, new Date(NOW - 600_000).toISOString(), AFTER_STORED);
}

function list(kinds: CredentialKind[], statuses: CredentialStatus[], logins: LoginView[] = []): Connection[] {
  return connections({ kinds, statuses, logins, unavailable: null }, checklistState, NOW);
}

/**
 * The exhaustiveness itself is the compiler's: `CONNECTORS` is declared `satisfies Record<CredentialKind, …>`, so a
 * new kind without an entry does not build. These pin what the entries have to say, which the type cannot.
 */
describe("CONNECTORS", () => {
  it("should word every kind of credential the hub keeps when asked", () => {
    expect(new Set(Object.keys(CONNECTORS))).toEqual(new Set(CREDENTIAL_KINDS));
  });

  it("should ask the person to paste exactly the connections their assistant cannot sign in to itself", () => {
    const pasted = CREDENTIAL_KINDS.filter((kind) => isConnection(kind) && CONNECTORS[kind]?.paste !== null);

    expect(pasted).toEqual(CREDENTIAL_KINDS.filter((kind) => isConnection(kind) && !isSignInKind(kind)));
  });

  it("should word every connection the Assistant can ask for, on every model route", () => {
    for (const kind of [...ROUTES.flatMap(neededCredentials), ...OPTIONAL_CREDENTIALS]) {
      expect(CONNECTORS[kind]).not.toBeNull();
    }
  });

  // The owner's decision: an Amazon Bedrock API key is an administrator's to paste on the hub's own credentials page,
  // and must never be asked of the person whose chats run on it. It is still worded, because `CONNECTORS` is total
  // over `CredentialKind` and that page reads the same words.
  it("should ask for no model key at all on the route everybody signing in is put on", () => {
    expect(neededCredentials(modelRouteFor(true))).not.toContain("bedrock");
    expect(neededCredentials(modelRouteFor(false))).not.toContain("bedrock");
    expect(CONNECTORS.bedrock).not.toBeNull();
  });
});

describe("isConnection", () => {
  it.each(["github", "azure", "atlassian", "jenkins", "claude", "bedrock"] as const)("should count %s as a sign-in when asked", (kind) => {
    expect(isConnection(kind)).toBe(true);
  });

  it.each(["claude_md", "git_identity"] as const)("should not count %s as a sign-in when asked", (kind) => {
    expect(isConnection(kind)).toBe(false);
  });

  it("should answer for every kind of credential the hub keeps when asked", () => {
    expect(CREDENTIAL_KINDS.filter(isConnection)).toEqual(["github", "azure", "claude", "bedrock", "jenkins", "atlassian"]);
  });
});

describe("connectionState", () => {
  it("should be connected when the credential is stored", () => {
    expect(connectionState("stored", undefined, held(), NOW)).toBe("connected");
  });

  it("should be connected when the credential is stored and an older sign-in failed", () => {
    expect(connectionState("stored", login("github", "failed"), held(), NOW)).toBe("connected");
  });

  it("should be signing in when a sign-in is waiting for a person who has none stored", () => {
    expect(connectionState("login", login("github", "pending"), NONE, NOW)).toBe("signing-in");
  });

  it("should be refreshing when a sign-in is relayed for a credential that is already stored", () => {
    expect(connectionState("login", login("github", "pending"), held(), NOW)).toBe("refreshing");
  });

  it.each([held(), NONE])("should be finishing when the person has sent a code back and the pod has yet to take it", (stored) => {
    const sent = { ...login("claude", "pending"), prompt: "paste_code" as const, userCode: null, codeWaitingUntil: new Date(NOW + 5 * 60_000).toISOString() };

    expect(connectionState("login", sent, stored, NOW)).toBe("finishing");
  });

  it("should be waiting when nothing is stored and no sign-in has been asked for", () => {
    expect(connectionState("waiting", undefined, NONE, NOW)).toBe("waiting");
  });

  it("should be waiting when nothing is known about the credential at all", () => {
    expect(connectionState("waiting", undefined, undefined, NOW)).toBe("waiting");
  });

  it("should be waiting when a sign-in completed but its credential is no longer stored", () => {
    expect(connectionState("waiting", login("github", "completed"), NONE, NOW)).toBe("waiting");
  });

  it("should be failed when the last sign-in failed and nothing is stored", () => {
    expect(connectionState("waiting", login("azure", "failed"), NONE, NOW)).toBe("failed");
  });

  it("should be expired when the last sign-in expired and nothing is stored", () => {
    expect(connectionState("waiting", login("azure", "expired"), NONE, NOW)).toBe("expired");
  });

  it("should be expired when a sign-in is still pending but its code ran out", () => {
    expect(connectionState("waiting", login("azure", "pending", new Date(NOW - 1000).toISOString()), NONE, NOW)).toBe("expired");
  });

  it("should be expired when the credential is stored and a later sign-in expired over it", () => {
    expect(connectionState("stored", lapsed("atlassian"), held(), NOW)).toBe("expired");
  });

  it("should be failed when the credential is stored and a later sign-in failed over it", () => {
    expect(connectionState("stored", lapsed("atlassian", "failed"), held(), NOW)).toBe("failed");
  });

  it("should be expired when the credential is stored with no record of when it was saved and a sign-in lapsed", () => {
    expect(connectionState("stored", lapsed("atlassian"), held(null), NOW)).toBe("expired");
  });

  /**
   * Nothing in the hub writes `expired` over a `pending` row — only a pod's report does — so a pod that stops before
   * reporting leaves a code that ran out looking like one still in flight, over a credential it could not use.
   */
  it("should be expired when a code ran out over a stored credential and no pod ever reported it", () => {
    const unreported = login("atlassian", "pending", new Date(NOW - 60_000).toISOString(), AFTER_STORED);

    expect(connectionState("stored", unreported, held(), NOW)).toBe("expired");
  });
});

describe("lapsedSinceStored", () => {
  it("should count a sign-in that lapsed after the credential was saved when asked", () => {
    expect(lapsedSinceStored(lapsed("atlassian"), held(), NOW)).toBe(true);
  });

  it("should not count a sign-in that lapsed before the credential was saved when asked", () => {
    expect(lapsedSinceStored(login("atlassian", "failed"), held(), NOW)).toBe(false);
  });

  it("should count a code that ran out after the credential was saved, reported or not", () => {
    expect(lapsedSinceStored(login("atlassian", "pending", new Date(NOW - 1000).toISOString(), AFTER_STORED), held(), NOW)).toBe(true);
  });

  it("should not count a code that is still live, which is a sign-in nobody has had time to finish", () => {
    expect(lapsedSinceStored(login("atlassian", "pending", new Date(NOW + 1000).toISOString(), AFTER_STORED), held(), NOW)).toBe(false);
  });

  it("should not count a completed sign-in, which is the credential being there rather than failing", () => {
    expect(lapsedSinceStored(login("atlassian", "completed", undefined, AFTER_STORED), held(), NOW)).toBe(false);
  });

  it("should not count anything when there is no sign-in to go on", () => {
    expect(lapsedSinceStored(undefined, held(), NOW)).toBe(false);
  });

  it("should count a lapsed sign-in with nothing stored, which there is nothing newer to contradict", () => {
    expect(lapsedSinceStored(login("atlassian", "expired"), NONE, NOW)).toBe(true);
  });
});

/**
 * What decides whether a sign-in that is over has anywhere to go, which is what both the screen's rows and the ask
 * are filtered on. The two halves are two different actions, and this is the tie between what it offers them for and
 * what each will accept: `reconnectSignIn` takes a `SignInKind`, and `saveCredential` takes a value only for a
 * credential the person's assistant uses.
 */
describe("canSignInAgain", () => {
  const NOTHING: CredentialKind[] = [];

  it.each([
    ["it uses nothing else", NOTHING],
    ["it uses its own route's credentials", neededCredentials("bedrock")],
    ["it uses every credential there is", [...CREDENTIAL_KINDS]]
  ])("should offer every sign-in the assistant makes for itself when %s", (_what, uses) => {
    const offered = CREDENTIAL_KINDS.filter((kind) => canSignInAgain(kind, uses));

    expect(CREDENTIAL_KINDS.filter(isSignInKind).filter((kind) => !offered.includes(kind))).toEqual([]);
  });

  it("should offer no more than those when the assistant uses nothing the person pastes", () => {
    expect(CREDENTIAL_KINDS.filter((kind) => canSignInAgain(kind, NOTHING))).toEqual(CREDENTIAL_KINDS.filter(isSignInKind));
  });

  it("should offer a credential the person pastes only while their assistant uses it", () => {
    expect(canSignInAgain("jenkins", ["jenkins"])).toBe(true);
    expect(canSignInAgain("jenkins", NOTHING)).toBe(false);
  });

  // The state the rule exists for: `saveCredential` refuses a Claude token from somebody not on their own licence,
  // so a lapsed Claude row would be an ask with a box that cannot be answered and no reconnect to fall back on.
  it("should offer no Claude sign-in to an assistant that does not run on the person's own licence", () => {
    expect(canSignInAgain("claude", neededCredentials("gateway"))).toBe(false);
    expect(canSignInAgain("claude", neededCredentials("bedrock"))).toBe(false);
    expect(canSignInAgain("claude", neededCredentials("own-licence"))).toBe(true);
  });

  // The pasted key has no way back on any route a sign-in puts somebody on, which is what keeps it off every ask.
  it("should offer no Bedrock key to an assistant on a route that does not use one", () => {
    expect(canSignInAgain("bedrock", [...neededCredentials("gateway"), ...optionalCredentials("gateway")])).toBe(false);
    expect(canSignInAgain("bedrock", [...neededCredentials("own-licence"), ...optionalCredentials("own-licence")])).toBe(false);
  });

  it("should offer nothing that is not a sign-in at all", () => {
    expect(canSignInAgain("claude_md", ["claude_md"])).toBe(false);
    expect(canSignInAgain("git_identity", ["git_identity"])).toBe(false);
  });
});

describe("codeCollectable", () => {
  /** A login the person has pasted a code for, which the pod has until `until` to collect. */
  function sent(until: string | null): LoginView {
    return { ...login("claude", "pending"), prompt: "paste_code", userCode: null, codeWaitingUntil: until };
  }

  it("should count a pasted code the pod can still collect when asked", () => {
    expect(codeCollectable(sent(new Date(NOW + 60_000).toISOString()), NOW)).toBe(true);
  });

  /**
   * `takePastedCode` hands the pod nothing once the deadline has passed and leaves the column set, and a login runs
   * for `MAX_LOGIN_SECONDS` while a pasted code keeps for `PASTED_CODE_TTL_MS`. Reading the column as the answer
   * would tell the person their code was on its way for the next fifty minutes with the box to paste another hidden,
   * while `storePastedCode` would still take one.
   */
  it("should not count a pasted code the pod can no longer collect, whatever the column still says", () => {
    expect(codeCollectable(sent(new Date(NOW - 1000).toISOString()), NOW)).toBe(false);
  });

  it("should not count a sign-in nobody has pasted a code for when asked", () => {
    expect(codeCollectable(sent(null), NOW)).toBe(false);
  });

  it("should not count anything when there is no sign-in to go on", () => {
    expect(codeCollectable(undefined, NOW)).toBe(false);
  });
});

describe("needsPerson", () => {
  const WAITS_ON_THEM: ConnectionState[] = ["refreshing", "signing-in", "expired", "failed"];
  const DOES_NOT: ConnectionState[] = ["connected", "finishing", "waiting"];

  it.each(WAITS_ON_THEM)("should count %s as a sign-in only the person can finish", (state) => {
    expect(needsPerson(state)).toBe(true);
  });

  it.each(DOES_NOT)("should not count %s as a sign-in waiting on the person", (state) => {
    expect(needsPerson(state)).toBe(false);
  });

  /**
   * Every surface that prompts is built on this, so a state it had no answer for would be a sign-in nobody was told
   * about. The guarantee is the table it reads, which does not compile without an entry; this pins that the states
   * above are all of them, so a new one is a decision taken here as well.
   */
  it("should be decided for every state a sign-in can be in", () => {
    expect([...WAITS_ON_THEM, ...DOES_NOT].sort((a, b) => a.localeCompare(b))).toEqual([...CONNECTION_STATES].sort((a, b) => a.localeCompare(b)));
  });
});

describe("hasLapsed", () => {
  const LAPSED: ConnectionState[] = ["expired", "failed"];
  const NOT: ConnectionState[] = ["connected", "finishing", "refreshing", "signing-in", "waiting"];

  it.each(LAPSED)("should count %s as a sign-in that has lapsed", (state) => {
    expect(hasLapsed(state)).toBe(true);
  });

  it.each(NOT)("should not count %s as a sign-in that has lapsed", (state) => {
    expect(hasLapsed(state)).toBe(false);
  });

  it("should be decided for every state a sign-in can be in", () => {
    expect([...LAPSED, ...NOT].sort((a, b) => a.localeCompare(b))).toEqual([...CONNECTION_STATES].sort((a, b) => a.localeCompare(b)));
  });
});

describe("connections", () => {
  it("should keep the order it is given when it builds the rows", () => {
    const rows = list(["github", "azure", "bedrock", "jenkins", "atlassian"], []);

    expect(rows.map((row) => row.kind)).toEqual(["github", "azure", "bedrock", "jenkins", "atlassian"]);
  });

  it("should leave out a CLAUDE.md and a git identity when they are among the kinds", () => {
    const rows = list(["github", "claude_md", "git_identity", "atlassian"], []);

    expect(rows.map((row) => row.kind)).toEqual(["github", "atlassian"]);
  });

  it("should describe each sign-in in the Assistant's own words when it builds the rows", () => {
    const [row] = list(["atlassian"], []);

    expect(row).toMatchObject({ name: "Atlassian", initial: "A", desc: CONNECTORS.atlassian?.desc, state: "waiting", detail: "Not connected" });
  });

  it("should say the person is connected when their credential is stored", () => {
    const [row] = list(["github"], [status("github", true)]);

    expect(row).toMatchObject({ state: "connected", detail: "Connected" });
  });

  it("should show the account the sign-in is for when the hub recorded one", () => {
    const [row] = list(["github"], [status("github", true, "alice@hmcts.net")]);

    expect(row?.accountLabel).toBe("alice@hmcts.net");
  });

  it("should have no account label when nothing is stored", () => {
    const [row] = list(["github"], []);

    expect(row?.accountLabel).toBeNull();
  });

  it("should say a sign-in is waiting for the person when one is pending", () => {
    const [row] = list(["azure"], [status("azure", false)], [login("azure", "pending")]);

    expect(row).toMatchObject({ state: "signing-in", detail: "Waiting for you" });
  });

  it("should say the sign-in expired when its code ran out and nothing is stored", () => {
    const [row] = list(["azure"], [], [login("azure", "expired")]);

    expect(row).toMatchObject({ state: "expired", detail: "Sign-in expired" });
  });

  it("should say the last sign-in failed when it did and nothing is stored", () => {
    const [row] = list(["atlassian"], [], [login("atlassian", "failed")]);

    expect(row).toMatchObject({ state: "failed", detail: "Last sign-in failed" });
  });

  // A credential outlives the sign-in that failed to replace it, so being stored is not on its own a sign-in that
  // works: the row has to read from both facts or it reads "Connected" about a value a pod has just been refused.
  it("should say the sign-in expired when a stored credential is the one a later sign-in lapsed over", () => {
    const [row] = list(["atlassian"], [status("atlassian", true, "alice@hmcts.net")], [lapsed("atlassian")]);

    expect(row).toMatchObject({ state: "expired", detail: "Sign-in expired", accountLabel: "alice@hmcts.net" });
  });

  it("should still say the person is connected when a sign-in failed before their credential was stored", () => {
    const [row] = list(["atlassian"], [status("atlassian", true)], [login("atlassian", "failed")]);

    expect(row).toMatchObject({ state: "connected", detail: "Connected" });
  });

  it("should ignore a status and a sign-in for another kind when it builds a row", () => {
    const [row] = list(["github"], [status("azure", true)], [login("azure", "pending")]);

    expect(row).toMatchObject({ kind: "github", state: "waiting" });
  });

  it("should give no rows when the hub cannot read the person's credentials", () => {
    const rows = connections({ kinds: ["github", "azure"], statuses: [], logins: [], unavailable: "no Key Vault here" }, checklistState, NOW);

    expect(rows).toEqual([]);
  });

  it("should give no rows when there is nothing loaded to build them from", () => {
    expect(connections(undefined, checklistState, NOW)).toEqual([]);
  });
});

describe("connectionsWarning", () => {
  it("should be nothing when every prompted sign-in is connected", () => {
    const rows = list(["github", "azure", "bedrock", "atlassian"], [status("github", true), status("azure", true), status("atlassian", true)]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  // Every kind is prompted about once the assistant has asked for it; being never set up prompts only for the one
  // sign-in the assistant cannot start without, and the model route is left to the connections banner that asks for it.
  it("should prompt about only the one sign-in a person must have when none was ever set up", () => {
    expect([...PROMPTED_WHEN_MISSING]).toEqual(["github"]);
  });

  it("should say nothing about Azure when it was never connected, as it says nothing about Jenkins", () => {
    const rows = list(["github", "azure", "jenkins"], [status("github", true)]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  it("should say nothing about an Azure sign-in that lapsed, which settings offers to connect again", () => {
    const rows = list(["github", "azure"], [status("github", true), status("azure", true)], [lapsed("azure", "failed")]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  it("should warn about an Azure code the person asked for while it is live", () => {
    const rows = list(["github", "azure"], [status("github", true)], [login("azure", "pending")]);

    expect(connectionsWarning(rows)).toBe("Azure needs your attention");
  });

  it("should be nothing when there are no sign-ins to report on", () => {
    expect(connectionsWarning([])).toBeNull();
  });

  it("should name GitHub when it alone is not connected", () => {
    const rows = list(["github", "azure", "atlassian"], [status("atlassian", true)]);

    expect(connectionsWarning(rows)).toBe(`${CONNECTORS.github.name} needs your attention`);
  });

  it("should name both when GitHub is not connected and the optional one has lapsed", () => {
    const rows = list(["github", "azure", "atlassian"], [], [login("atlassian", "expired")]);

    expect(connectionsWarning(rows)).toBe("GitHub and Atlassian need your attention");
  });

  // The badge the lapsed-sign-in rule exists to raise: everything is stored, so nothing else on any surface says
  // the stored Atlassian sign-in is the one the pod could not use.
  it("should warn about a stored sign-in that a later sign-in lapsed over", () => {
    const rows = list(
      ["github", "azure", "atlassian"],
      [status("github", true), status("azure", true), status("atlassian", true)],
      [lapsed("atlassian", "failed")]
    );

    expect(connectionsWarning(rows)).toBe("Atlassian needs your attention");
  });

  it("should warn when a needed sign-in is still waiting for the person", () => {
    const rows = list(["github", "azure", "atlassian"], [status("azure", true), status("atlassian", true)], [login("github", "pending")]);

    expect(connectionsWarning(rows)).toBe("GitHub needs your attention");
  });

  // A relayed code is a wait on the person whatever is stored behind it: nobody but them can enter it, and a pod's
  // code lasts two minutes, so a badge nobody raises is a sign-in nobody completes.
  it("should warn about a sign-in relayed behind one that is already stored", () => {
    const rows = list(["github", "azure", "atlassian"], [status("github", true), status("azure", true)], [login("github", "pending")]);

    expect(connectionsWarning(rows)).toBe("GitHub needs your attention");
  });

  it("should not warn about an optional sign-in nobody ever set up", () => {
    const rows = list(["github", "azure", "atlassian"], [status("github", true), status("azure", true)]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  it.each(["expired", "failed"] as const)("should warn about an optional sign-in once it has %s", (state) => {
    const rows = list(["github", "azure", "atlassian"], [status("github", true), status("azure", true)], [login("atlassian", state)]);

    expect(connectionsWarning(rows)).toBe("Atlassian needs your attention");
  });

  it("should warn about an optional sign-in their assistant has relayed a code for", () => {
    const rows = list(
      ["github", "azure", "atlassian"],
      [status("github", true), status("azure", true), status("atlassian", true)],
      [login("atlassian", "pending")]
    );

    expect(connectionsWarning(rows)).toBe("Atlassian needs your attention");
  });

  it("should not warn about an optional sign-in that is over and done with", () => {
    const rows = list(
      ["github", "azure", "atlassian"],
      [status("github", true), status("azure", true), status("atlassian", true)],
      [login("atlassian", "completed")]
    );

    expect(connectionsWarning(rows)).toBeNull();
  });

  it("should not warn about model access when it is the only thing missing", () => {
    const rows = list(["github", "azure", "bedrock", "atlassian"], [status("github", true), status("azure", true), status("atlassian", true)]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  it("should not warn about a Jenkins token when it is the only thing missing", () => {
    const rows = list(["github", "azure", "jenkins", "atlassian"], [status("github", true), status("azure", true), status("atlassian", true)]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  it("should raise no warning nobody can act on when the hub cannot read the person's credentials", () => {
    const rows = connections({ kinds: [...PROMPTED_WHEN_MISSING], statuses: [], logins: [], unavailable: "no Key Vault here" }, checklistState, NOW);

    expect(connectionsWarning(rows)).toBeNull();
  });
});

/**
 * The ask that reaches someone already sitting in the Assistant, whose other surfaces each need something of the
 * visit: the getting-ready screen that they have not dismissed it, the Jira footer that an export is pending. This
 * needs only a sign-in waiting on them, so it is the one that holds whenever one is.
 */
describe("signInPrompt", () => {
  const CONNECTED = [status("github", true), status("azure", true), status("atlassian", true)];

  it("should have nothing to say when every sign-in is connected", () => {
    expect(signInPrompt(list(["github", "azure", "atlassian"], CONNECTED))).toBeNull();
  });

  it("should have nothing to say about a sign-in nobody ever set up, which the connect ask covers", () => {
    expect(signInPrompt(list(["github", "azure", "atlassian"], []))).toBeNull();
  });

  it("should name the sign-in when a code is waiting behind a stored credential", () => {
    const prompt = signInPrompt(list(["github", "azure", "atlassian"], CONNECTED, [login("atlassian", "pending")]));

    expect(prompt).toEqual({
      label: "Sign in",
      message: "Your assistant is waiting for you to sign in to Atlassian.",
      action: "Show the sign-in"
    });
  });

  // Worded apart from a live code, because what there is to do differs — type this, or ask for another — and because
  // a sentence that read the same for both would be read out once and then not again when the thing to do changed.
  it("should say the sign-in could not be made when a stored credential is the one it lapsed over", () => {
    expect(signInPrompt(list(["github", "azure", "atlassian"], CONNECTED, [lapsed("atlassian")]))?.message).toBe(
      "Your assistant could not sign in to Atlassian, and is not asking again by itself."
    );
  });

  it("should name every sign-in waiting on the person when more than one is", () => {
    const rows = list(["github", "azure", "atlassian"], CONNECTED, [login("github", "pending"), lapsed("atlassian", "failed")]);

    expect(signInPrompt(rows)?.message).toBe("Your assistant is waiting for you to sign in to GitHub and Atlassian.");
  });

  it("should have nothing to say when the hub cannot read the credentials, since it knows of no sign-in at all", () => {
    const rows = connections(
      { kinds: ["github", "atlassian"], statuses: [], logins: [lapsed("atlassian")], unavailable: "no Key Vault here" },
      checklistState,
      NOW
    );

    expect(signInPrompt(rows)).toBeNull();
  });
});

describe("connectionsData", () => {
  const assistant = { needed: ["github", "azure", "bedrock"] as CredentialKind[], optional: ["jenkins", "atlassian"] as CredentialKind[], logins: [] };

  it("should ask for the needed sign-ins before the optional ones when the credentials are readable", () => {
    const data = connectionsData(assistant, { available: true, statuses: [status("github", true)] });

    expect(data.kinds).toEqual(["github", "azure", "bedrock", "jenkins", "atlassian"]);
    expect(data.statuses).toEqual([status("github", true)]);
    expect(data.unavailable).toBeNull();
  });

  it("should carry the sign-ins the assistant has relayed when there are any", () => {
    const pending = login("github", "pending");

    const data = connectionsData({ ...assistant, logins: [pending] }, { available: true, statuses: [] });

    expect(data.logins).toEqual([pending]);
  });

  it("should give no statuses and say why when the hub cannot read the person's credentials", () => {
    const data = connectionsData(assistant, { available: false, reason: "the credentials Key Vault is not configured" });

    expect(data.statuses).toEqual([]);
    expect(data.unavailable).toBe("the credentials Key Vault is not configured");
  });
});

/**
 * What the getting-ready screen is allowed to leave out. Anything the person is being asked for and cannot see is
 * the one failure that has no way out from their side: the assistant sits in `awaiting_login` and every row they can
 * see reads as connected.
 */
describe("offeredConnections", () => {
  function offer(needed: CredentialKind[], logins: LoginView[] = []) {
    return offeredConnections({ needed, optional: OPTIONAL_CREDENTIALS, logins }, NOW).map((row) => row.kind);
  }

  /** What one route's assistant is offered, with each of its own lists rather than every optional kind there is. */
  function offerFor(route: ModelRoute, logins: LoginView[] = []) {
    return offeredConnections({ needed: neededCredentials(route), optional: optionalCredentials(route), logins }, NOW).map((row) => row.kind);
  }

  it.each(ROUTES)("should offer a row for every credential the %s route needs", (route) => {
    const needed = neededCredentials(route);

    expect(offer(needed)).toEqual(expect.arrayContaining(needed));
  });

  // The ask and the row are the same list, so the screen offering a kind twice would be the banner naming it twice.
  it.each(ROUTES)("should offer each kind once however many of its lists it is on, on the %s route", (route) => {
    const offered = offerFor(route);

    expect(offered).toEqual([...new Set(offered)]);
  });

  it("should offer GitHub, the Azure sign-in the gateway authorises and nothing else of the person's on the gateway route", () => {
    expect(offerFor("gateway")).toEqual(["github", "azure", "atlassian"]);
  });

  // Nothing on this route asks for the key, so there is no row to paste one into — and a lapsed ask for it is one
  // `saveCredential` would refuse, which is the row `canSignInAgain` exists to keep off the screen. (A *live* relay
  // of any kind is still offered, whatever route it is: see the test above. No pod relays this one.)
  it.each(["failed", "expired"] as const)("should offer no Bedrock key row on the gateway route when a %s ask for one is on the record", (state) => {
    expect(offerFor("gateway", [login("bedrock", state)])).not.toContain("bedrock");
  });

  it("should offer the needed connections before the optional one it offers unasked", () => {
    expect(offer(["github", "azure", "bedrock"])).toEqual(["github", "azure", "bedrock", "atlassian"]);
  });

  it("should offer no connection that is neither needed, nor asked for, nor the optional one it offers", () => {
    const offered = offer(["github", "azure", "claude"]);

    expect(offered.filter((kind) => !["github", "azure", "claude", ...OFFERED_OPTIONAL].includes(kind))).toEqual([]);
  });

  it("should offer a row for an optional sign-in the pod has stopped to ask for", () => {
    expect(offer(["github", "azure", "bedrock"], [login("jenkins", "pending")])).toEqual(["github", "azure", "bedrock", "jenkins", "atlassian"]);
  });

  // Which kinds a pod relays is decided in another repo, so this holds whatever that answer becomes rather than only
  // for the kinds the hub's own `needed` and `optional` happen to name.
  it("should offer a row for a sign-in the pod asks for that is neither needed nor optional", () => {
    expect(offer(["github", "azure", "bedrock"], [login("claude", "pending")])).toEqual(["github", "azure", "bedrock", "claude", "atlassian"]);
  });

  it("should offer each asked-for connection once when it is needed as well", () => {
    expect(offer(["github", "azure", "bedrock"], [login("azure", "pending"), login("atlassian", "pending")])).toEqual([
      "github",
      "azure",
      "bedrock",
      "atlassian"
    ]);
  });

  // The status does not move back when a code runs out, so the ask outlasts the code and the row has to as well.
  it("should offer a row for an asked-for sign-in whose code has run out", () => {
    const stale = login("jenkins", "pending", new Date(NOW - 600_000).toISOString());

    expect(offer(["github", "azure", "bedrock"], [stale])).toContain("jenkins");
  });

  it("should offer no row for an optional sign-in that is over and done with", () => {
    expect(offer(["github", "azure", "bedrock"], [login("jenkins", "completed")])).not.toContain("jenkins");
  });

  /**
   * `OPTIONAL_CREDENTIALS` holds Jenkins but `OFFERED_OPTIONAL` does not, so a Jenkins sign-in has a row only while
   * it is relayed. A lapsed one is the state with most to say and no other row to say it on, and the banner names
   * from this same set — so leaving it out is an ask pointing at a screen with nothing on it.
   */
  it.each(["expired", "failed"] as const)("should offer a row for an optional sign-in a pod reported %s", (state) => {
    expect(offer(["github", "azure", "bedrock"], [login("jenkins", state)])).toContain("jenkins");
  });

  /**
   * `saveCredential` refuses a Claude token from somebody whose agents run on Amazon Bedrock, and the only control a
   * lapsed Claude row has is that box. Nothing clears the login row either — `startLogin` overwrites only on a new
   * relay, and the states that end one need a pod's report — so a row here would be a banner naming a sign-in the
   * person can neither satisfy nor dismiss, for good. The ask names from this set, so leaving it out covers both.
   */
  it.each(["expired", "failed"] as const)("should offer no row for a %s sign-in the hub would take no value for", (state) => {
    expect(offer(["github", "azure", "bedrock"], [login("claude", state)])).not.toContain("claude");
  });

  it("should offer no row for a code that ran out for a kind the hub would take no value for", () => {
    const stale = login("claude", "pending", new Date(NOW - 1000).toISOString());

    expect(offer(["github", "azure", "bedrock"], [stale])).not.toContain("claude");
  });

  // A live one is always offered, whatever the kind: finishing it sends the code back to the pod through
  // `storePastedCode`, which is not route-aware, so there is always something to do about it.
  it("should offer a row for a live sign-in even for a kind the hub would take no value for", () => {
    expect(offer(["github", "azure", "bedrock"], [login("claude", "pending")])).toContain("claude");
  });

  it("should offer no row for a credential that is not a connection", () => {
    expect(offer(["github", "claude_md", "git_identity"])).toEqual(["github", "atlassian"]);
  });

  it("should word every row it offers", () => {
    for (const row of offeredConnections(
      { needed: ["github", "azure", "claude"], optional: OPTIONAL_CREDENTIALS, logins: [login("jenkins", "pending")] },
      NOW
    )) {
      expect(row.connector.name).not.toBe("");
      expect(row.connector.initial).not.toBe("");
    }
  });

  it("should offer Atlassian, and only Atlassian, of the optional connections unasked", () => {
    expect([...OFFERED_OPTIONAL]).toEqual(["atlassian"]);
  });
});

describe("sign-ins made on request", () => {
  function offer(logins: LoginView[] = []) {
    return offeredConnections({ needed: neededCredentials("own-licence"), optional: OPTIONAL_CREDENTIALS, logins }, NOW).map((row) => row.kind);
  }

  it("should sign in to Azure, and nothing else, only when the person asks", () => {
    expect([...ON_REQUEST]).toEqual(["azure"]);
    expect(signsInOnRequest("azure")).toBe(true);
    expect(signsInOnRequest("atlassian")).toBe(false);
  });

  it("should offer no Azure row on the getting-ready screen when nobody has asked for one", () => {
    expect(offer()).not.toContain("azure");
  });

  it("should offer an Azure row while the code the person asked for is live", () => {
    expect(offer([login("azure", "pending")])).toContain("azure");
  });

  it.each(["expired", "failed"] as const)("should offer no Azure row when the sign-in the person asked for %s", (state) => {
    expect(offer([login("azure", state)])).not.toContain("azure");
  });

  it("should raise no sign-in ask for an Azure sign-in that lapsed", () => {
    const rows = list(["azure"], [], [login("azure", "expired")]);

    expect(signInPrompt(rows)).toBeNull();
  });

  it("should ask the person to sign in to Azure while the code they asked for is live", () => {
    const rows = list(["azure"], [], [login("azure", "pending")]);

    expect(signInPrompt(rows)?.message).toBe("Your assistant is waiting for you to sign in to Azure.");
  });

  it.each([
    ["waiting", true],
    ["expired", true],
    ["failed", true],
    ["connected", false],
    ["signing-in", false],
    ["refreshing", false],
    ["finishing", false]
  ] as const)("should offer to connect Azure from settings when it is %s: %s", (state, expected) => {
    expect(offersConnect({ kind: "azure", state })).toBe(expected);
  });

  it.each(["github", "jenkins", "atlassian"] as const)("should offer no connect from settings for %s, which is not made on request", (kind) => {
    expect(offersConnect({ kind, state: "waiting" })).toBe(false);
  });

  it("should say whether a value is saved on each row", () => {
    const rows = list(["github", "azure"], [status("azure", true)]);

    expect(rows.map((row) => [row.kind, row.stored])).toEqual([
      ["github", false],
      ["azure", true]
    ]);
  });
});

describe("connectionsPrompt", () => {
  const NOTHING = new Set<CredentialKind>();

  it("should name the one connection left when only one is", () => {
    expect(connectionsPrompt("connect", ["github", "azure", "claude"], new Set<CredentialKind>(["github", "azure"]))).toEqual({
      label: "Connect your accounts",
      message: "Your assistant needs Claude before it can work for you.",
      action: "Connect accounts"
    });
  });

  it("should name every connection left, in the order the screen lists them, when several are", () => {
    expect(connectionsPrompt("connect", ["github", "azure", "bedrock"], new Set<CredentialKind>(["azure"]))?.message).toBe(
      "Your assistant needs GitHub and AI model access before it can work for you."
    );
    expect(connectionsPrompt("connect", ["github", "azure", "bedrock"], NOTHING)?.message).toBe(
      "Your assistant needs GitHub, Azure and AI model access before it can work for you."
    );
  });

  // The ask is shown because `connectionsAsk` said there is something to connect, so it asks in general rather than
  // going quiet when the lists it was handed name nothing.
  it("should ask in general when nothing it was given names anything to do", () => {
    expect(connectionsPrompt("connect", [], NOTHING)?.message).toBe("Your assistant needs you to connect your accounts before it can work for you.");
  });

  it("should name a credential by its kind when there is no wording for it", () => {
    expect(connectionsPrompt("connect", ["claude_md"], NOTHING)?.message).toBe("Your assistant needs claude_md before it can work for you.");
  });

  // The whole point of `unknown`: it must not read as "connect these", because as far as anyone knows they are
  // connected and there is nothing the person can do about the hub not being able to see them.
  it("should say the sign-ins cannot be checked, and name no connection, when the hub cannot read them", () => {
    const prompt = connectionsPrompt("unknown", ["github", "azure", "claude"], NOTHING);

    expect(prompt?.label).toBe("Your sign-ins cannot be checked");
    expect(prompt?.message).toContain("still connected");
    expect(prompt?.message).toContain("nothing for you to set up again");
    expect(prompt?.message).not.toContain("needs");
    for (const name of ["GitHub", "Azure", "Claude"]) {
      expect(prompt?.message).not.toContain(name);
    }
  });

  it("should word the two asks differently so neither can be read as the other", () => {
    const connect = connectionsPrompt("connect", ["github"], NOTHING);
    const unknown = connectionsPrompt("unknown", ["github"], NOTHING);

    expect(connect?.label).not.toBe(unknown?.label);
    expect(connect?.message).not.toBe(unknown?.message);
    expect(connect?.action).not.toBe(unknown?.action);
  });

  it("should have nothing to say when every needed connection is made", () => {
    expect(connectionsPrompt("done", ["github"], new Set<CredentialKind>(["github"]))).toBeNull();
  });
});

describe("inWords", () => {
  it.each([
    [[], ""],
    [["A"], "A"],
    [["A", "B"], "A and B"],
    [["A", "B", "C"], "A, B and C"]
  ])("should read %j as %j", (names, expected) => {
    expect(inWords(names)).toBe(expected);
  });
});
