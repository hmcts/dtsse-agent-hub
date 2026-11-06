import { describe, expect, it } from "vitest";
import type { CredentialKind } from "../credentials/names.ts";
import type { CredentialStatus } from "../credentials/store.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import { connectionRows } from "./connection-rows.ts";
import { checklistState, connections, microsoftConnection, modelAccess } from "./connections.ts";
import { savedCredentials } from "./saved-credentials.ts";

const NOW = Date.parse("2026-11-05T09:00:00.000Z");

function status(kind: CredentialKind, accountLabel: string | null = null): CredentialStatus {
  return { kind, stored: true, accountLabel, updatedAt: "2026-11-01T09:00:00.000Z" };
}

/** The rows a page would build for this route, these sign-ins and these stored credentials. */
function rows(route: ModelRoute, kinds: CredentialKind[], stored: CredentialStatus[]) {
  const data = { route, microsoftConnectable: true, kinds, statuses: stored, logins: [], unavailable: null };
  const list = connections(data, checklistState, NOW);
  return connectionRows(list, modelAccess(route, list), savedCredentials(stored, route, route === "own-licence"), microsoftConnection(data), route);
}

describe("connectionRows", () => {
  it("should give each service one row, carrying both its sign-in and its saved credential, when it has both", () => {
    const listed = rows("own-licence", ["github", "claude", "jenkins"], [status("github", "alice"), status("claude")]);

    expect(listed.map((row) => row.key)).toEqual(["github", "claude", "jenkins", "microsoft"]);
    expect(listed[0]).toMatchObject({ name: "GitHub", desc: "alice", state: "connected", signIn: { kind: "github" }, saved: { kind: "github" } });
  });

  it("should list a credential saved for a service no sign-in is asked for after the sign-ins, and before Microsoft 365", () => {
    const listed = rows("own-licence", ["github"], [status("github"), status("atlassian", "a.person@hmcts.net")]);

    expect(listed.map((row) => row.key)).toEqual(["github", "claude", "jenkins", "atlassian", "microsoft"]);
    expect(listed.find((row) => row.key === "atlassian")).toMatchObject({
      name: "Atlassian",
      desc: "a.person@hmcts.net",
      detail: "Connected",
      signIn: null,
      saved: { kind: "atlassian", stored: true }
    });
  });

  it("should put the model-access row after GitHub, and a saved Claude token on it, when the agents reach Claude through the gateway", () => {
    const listed = rows("gateway", ["github", "azure"], [status("github"), status("azure"), status("claude")]);

    expect(listed.map((row) => row.key)).toEqual(["github", "model-access", "azure", "jenkins", "microsoft"]);
    expect(listed[1]).toMatchObject({ name: "Claude", saved: { kind: "claude" } });
  });

  // The saved Microsoft 365 credential is what its row disconnects, so a second row for it would be the same service twice.
  it("should give Microsoft 365 one row, its own, when its connection is stored", () => {
    const listed = rows("own-licence", ["github"], [status("github"), status("microsoft", "a.person@hmcts.net")]);

    expect(listed.filter((row) => row.name.includes("Microsoft"))).toHaveLength(1);
    expect(listed.at(-1)).toMatchObject({ key: "microsoft", desc: "a.person@hmcts.net", state: "connected", saved: null, microsoft: { stored: true } });
  });

  it("should list nothing when the hub cannot read the person's credentials", () => {
    const data = { route: "own-licence" as const, microsoftConnectable: true, kinds: ["github" as const], statuses: [], logins: [], unavailable: "no store" };

    expect(connectionRows(connections(data, checklistState, NOW), null, [], microsoftConnection(data), "own-licence")).toEqual([]);
  });
});
