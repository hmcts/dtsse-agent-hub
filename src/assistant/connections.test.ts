import { describe, expect, it } from "vitest";
import { checklistState } from "@/components/virtual-agents/OnboardingChecklist";
import { CREDENTIAL_KINDS, type CredentialKind } from "../credentials/names.ts";
import type { CredentialStatus } from "../credentials/store.ts";
import { isSignInKind, type LoginState, type LoginView } from "../virtual-agents/logins.ts";
import { neededCredentials, OPTIONAL_CREDENTIALS } from "../virtual-agents/views.ts";
import {
  type ChecklistAnswer,
  CONNECTORS,
  type Connection,
  connectionState,
  connections,
  connectionsData,
  connectionsPrompt,
  connectionsWarning,
  hasLapsed,
  inWords,
  isConnection,
  isUsable,
  OFFERED_OPTIONAL,
  offeredConnections,
  PROMPTED_CONNECTIONS,
  PROMPTED_WHEN_LAPSED
} from "./connections.ts";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");

function status(kind: CredentialKind, stored: boolean, accountLabel: string | null = null): CredentialStatus {
  return { kind, stored, accountLabel, updatedAt: stored ? "2026-10-24T09:00:00.000Z" : null, updatedVia: stored ? "pod" : null };
}

function login(kind: CredentialKind, state: LoginState, expiresAt = new Date(NOW + 600_000).toISOString()): LoginView {
  return { kind, prompt: "device_code", userCode: "ABCD-1234", verificationUri: "https://example.com/device", expiresAt, state, codeWaiting: false };
}

/** The checklist the virtual agent's own page uses, which `connections` is given rather than reimplementing. */
const checklist = (stored: boolean, pending: LoginView | undefined): ChecklistAnswer => checklistState(stored, pending, NOW);

function list(kinds: CredentialKind[], statuses: CredentialStatus[], logins: LoginView[] = []): Connection[] {
  return connections({ kinds, statuses, logins, unavailable: null }, checklist);
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

  it("should word every connection the Assistant can ask for, on either model route", () => {
    for (const kind of [...neededCredentials("own-licence"), ...neededCredentials("bedrock"), ...OPTIONAL_CREDENTIALS]) {
      expect(CONNECTORS[kind]).not.toBeNull();
    }
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
    expect(connectionState("stored", undefined, true)).toBe("connected");
  });

  it("should be connected when the credential is stored and an older sign-in failed", () => {
    expect(connectionState("stored", login("github", "failed"), true)).toBe("connected");
  });

  it("should be signing in when a sign-in is waiting for a person who has none stored", () => {
    expect(connectionState("login", login("github", "pending"), false)).toBe("signing-in");
  });

  it("should be refreshing when a sign-in is relayed for a credential that is already stored", () => {
    expect(connectionState("login", login("github", "pending"), true)).toBe("refreshing");
  });

  it("should be waiting when nothing is stored and no sign-in has been asked for", () => {
    expect(connectionState("waiting", undefined, false)).toBe("waiting");
  });

  it("should be waiting when a sign-in completed but its credential is no longer stored", () => {
    expect(connectionState("waiting", login("github", "completed"), false)).toBe("waiting");
  });

  it("should be failed when the last sign-in failed and nothing is stored", () => {
    expect(connectionState("waiting", login("azure", "failed"), false)).toBe("failed");
  });

  it("should be expired when the last sign-in expired and nothing is stored", () => {
    expect(connectionState("waiting", login("azure", "expired"), false)).toBe("expired");
  });

  it("should be expired when a sign-in is still pending but its code ran out", () => {
    expect(connectionState("waiting", login("azure", "pending", new Date(NOW - 1000).toISOString()), false)).toBe("expired");
  });
});

describe("isUsable", () => {
  it.each(["connected", "refreshing"] as const)("should count %s as a sign-in the person can use", (state) => {
    expect(isUsable(state)).toBe(true);
  });

  it.each(["signing-in", "expired", "failed", "waiting"] as const)("should not count %s as a sign-in the person can use", (state) => {
    expect(isUsable(state)).toBe(false);
  });
});

describe("hasLapsed", () => {
  it.each(["expired", "failed"] as const)("should count %s as a sign-in that has lapsed", (state) => {
    expect(hasLapsed(state)).toBe(true);
  });

  it.each(["connected", "refreshing", "signing-in", "waiting"] as const)("should not count %s as a sign-in that has lapsed", (state) => {
    expect(hasLapsed(state)).toBe(false);
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

  it("should ignore a status and a sign-in for another kind when it builds a row", () => {
    const [row] = list(["github"], [status("azure", true)], [login("azure", "pending")]);

    expect(row).toMatchObject({ kind: "github", state: "waiting" });
  });

  it("should give no rows when the hub cannot read the person's credentials", () => {
    const rows = connections({ kinds: ["github", "azure"], statuses: [], logins: [], unavailable: "no Key Vault here" }, checklist);

    expect(rows).toEqual([]);
  });

  it("should give no rows when there is nothing loaded to build them from", () => {
    expect(connections(undefined, checklist)).toEqual([]);
  });
});

describe("connectionsWarning", () => {
  it("should be nothing when every prompted sign-in is connected", () => {
    const rows = list(["github", "azure", "bedrock", "atlassian"], [status("github", true), status("azure", true), status("atlassian", true)]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  it("should prompt about the needed sign-ins and, once lapsed, the optional one", () => {
    expect([...PROMPTED_CONNECTIONS]).toEqual(["github", "azure"]);
    expect([...PROMPTED_WHEN_LAPSED]).toEqual(["atlassian"]);
  });

  it("should be nothing when there are no sign-ins to report on", () => {
    expect(connectionsWarning([])).toBeNull();
  });

  it.each(["github", "azure"] as const)("should name %s when it alone is not connected", (kind) => {
    const stored = PROMPTED_CONNECTIONS.filter((other) => other !== kind).map((other) => status(other, true));
    const rows = list([...PROMPTED_CONNECTIONS], stored);

    expect(connectionsWarning(rows)).toBe(`${CONNECTORS[kind]?.name} needs your attention`);
  });

  it("should name both when neither needed sign-in is connected", () => {
    const rows = list(["github", "azure", "atlassian"], [status("atlassian", true)]);

    expect(connectionsWarning(rows)).toBe("GitHub and Azure need your attention");
  });

  it("should name all three when none of them is connected and the optional one has lapsed", () => {
    const rows = list(["github", "azure", "atlassian"], [], [login("atlassian", "expired")]);

    expect(connectionsWarning(rows)).toBe("GitHub, Azure and Atlassian need your attention");
  });

  it("should warn when a needed sign-in is still waiting for the person", () => {
    const rows = list(["github", "azure", "atlassian"], [status("azure", true), status("atlassian", true)], [login("github", "pending")]);

    expect(connectionsWarning(rows)).toBe("GitHub needs your attention");
  });

  it("should not warn about a sign-in being refreshed behind one that is already stored", () => {
    const rows = list(["github", "azure", "atlassian"], [status("github", true), status("azure", true)], [login("github", "pending")]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  it("should not warn about an optional sign-in nobody ever set up", () => {
    const rows = list(["github", "azure", "atlassian"], [status("github", true), status("azure", true)]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  it.each(["expired", "failed"] as const)("should warn about an optional sign-in once it has %s", (state) => {
    const rows = list(["github", "azure", "atlassian"], [status("github", true), status("azure", true)], [login("atlassian", state)]);

    expect(connectionsWarning(rows)).toBe("Atlassian needs your attention");
  });

  it("should not warn about an optional sign-in that is merely being refreshed", () => {
    const rows = list(
      ["github", "azure", "atlassian"],
      [status("github", true), status("azure", true), status("atlassian", true)],
      [login("atlassian", "pending")]
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
    const rows = connections({ kinds: [...PROMPTED_CONNECTIONS], statuses: [], logins: [], unavailable: "no Key Vault here" }, checklist);

    expect(connectionsWarning(rows)).toBeNull();
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
    return offeredConnections({ needed, optional: OPTIONAL_CREDENTIALS, logins }).map((row) => row.kind);
  }

  it.each(["own-licence", "bedrock"] as const)("should offer a row for every credential the %s route needs", (route) => {
    const needed = neededCredentials(route);

    expect(offer(needed)).toEqual(expect.arrayContaining(needed));
  });

  it("should offer the needed connections before the optional one it offers unasked", () => {
    expect(offer(["github", "azure", "bedrock"])).toEqual(["github", "azure", "bedrock", "atlassian"]);
  });

  it("should offer no connection that is neither needed nor optional", () => {
    const offered = offer(["github", "azure", "claude"]);

    expect(offered.filter((kind) => !["github", "azure", "claude", ...OPTIONAL_CREDENTIALS].includes(kind))).toEqual([]);
  });

  it("should offer a row for an optional sign-in the pod has stopped to ask for", () => {
    expect(offer(["github", "azure", "bedrock"], [login("jenkins", "pending")])).toEqual(["github", "azure", "bedrock", "jenkins", "atlassian"]);
  });

  // The status does not move back when a code runs out, so the ask outlasts the code and the row has to as well.
  it("should offer a row for an asked-for sign-in whose code has run out", () => {
    const stale = login("jenkins", "pending", new Date(NOW - 600_000).toISOString());

    expect(offer(["github", "azure", "bedrock"], [stale])).toContain("jenkins");
  });

  it("should offer no row for an optional sign-in that is over and done with", () => {
    expect(offer(["github", "azure", "bedrock"], [login("jenkins", "completed")])).not.toContain("jenkins");
  });

  it("should offer no row for a credential that is not a connection", () => {
    expect(offer(["github", "claude_md", "git_identity"])).toEqual(["github", "atlassian"]);
  });

  it("should word every row it offers", () => {
    for (const row of offeredConnections({ needed: ["github", "azure", "claude"], optional: OPTIONAL_CREDENTIALS, logins: [login("jenkins", "pending")] })) {
      expect(row.connector.name).not.toBe("");
      expect(row.connector.initial).not.toBe("");
    }
  });

  it("should offer Atlassian, and only Atlassian, of the optional connections unasked", () => {
    expect([...OFFERED_OPTIONAL]).toEqual(["atlassian"]);
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
