import { describe, expect, it } from "vitest";
import { checklistState } from "@/components/virtual-agents/OnboardingChecklist";
import { CREDENTIAL_KINDS, type CredentialKind } from "../credentials/names.ts";
import type { CredentialStatus } from "../credentials/store.ts";
import type { LoginState, LoginView } from "../virtual-agents/logins.ts";
import {
  type ChecklistAnswer,
  CONNECTORS,
  type Connection,
  connectionState,
  connections,
  connectionsData,
  connectionsWarning,
  isConnection,
  PROMPTED_CONNECTIONS
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
    expect(connectionState("stored", undefined)).toBe("connected");
  });

  it("should be connected when the credential is stored and an older sign-in failed", () => {
    expect(connectionState("stored", login("github", "failed"))).toBe("connected");
  });

  it("should be signing in when a sign-in is waiting for the person", () => {
    expect(connectionState("login", login("github", "pending"))).toBe("signing-in");
  });

  it("should be waiting when nothing is stored and no sign-in has been asked for", () => {
    expect(connectionState("waiting", undefined)).toBe("waiting");
  });

  it("should be waiting when a sign-in completed but its credential is no longer stored", () => {
    expect(connectionState("waiting", login("github", "completed"))).toBe("waiting");
  });

  it("should be failed when the last sign-in failed and nothing is stored", () => {
    expect(connectionState("waiting", login("azure", "failed"))).toBe("failed");
  });

  it("should be expired when the last sign-in expired and nothing is stored", () => {
    expect(connectionState("waiting", login("azure", "expired"))).toBe("expired");
  });

  it("should be expired when a sign-in is still pending but its code ran out", () => {
    expect(connectionState("waiting", login("azure", "pending", new Date(NOW - 1000).toISOString()))).toBe("expired");
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
  it("should be nothing when GitHub, Azure and Atlassian are all connected", () => {
    const rows = list(["github", "azure", "bedrock", "atlassian"], [status("github", true), status("azure", true), status("atlassian", true)]);

    expect(connectionsWarning(rows)).toBeNull();
  });

  it("should be nothing when there are no sign-ins to report on", () => {
    expect(connectionsWarning([])).toBeNull();
  });

  it.each(["github", "azure", "atlassian"] as const)("should name %s when it alone is not connected", (kind) => {
    const stored = PROMPTED_CONNECTIONS.filter((other) => other !== kind).map((other) => status(other, true));
    const rows = list([...PROMPTED_CONNECTIONS], stored);

    expect(connectionsWarning(rows)).toBe(`${CONNECTORS[kind]?.name} needs your attention`);
  });

  it("should name both when two of the three are not connected", () => {
    const rows = list(["github", "azure", "atlassian"], [status("azure", true)]);

    expect(connectionsWarning(rows)).toBe("GitHub and Atlassian need your attention");
  });

  it("should name all three when none of them is connected", () => {
    const rows = list(["github", "azure", "atlassian"], []);

    expect(connectionsWarning(rows)).toBe("GitHub, Azure and Atlassian need your attention");
  });

  it("should warn when a sign-in is still waiting for the person", () => {
    const rows = list(["github", "azure", "atlassian"], [status("azure", true), status("atlassian", true)], [login("github", "pending")]);

    expect(connectionsWarning(rows)).toBe("GitHub needs your attention");
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
