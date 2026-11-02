import { describe, expect, it } from "vitest";
import type { CredentialKind } from "../credentials/names.ts";
import type { CredentialStatus } from "../credentials/store.ts";
import { savedCredentials, savedCredentialsData } from "./saved-credentials.ts";

function stored(kind: CredentialKind): CredentialStatus {
  return { kind, stored: true, accountLabel: null, updatedAt: "2026-10-24T09:00:00.000Z", updatedVia: "pod" };
}

describe("savedCredentials", () => {
  it("should offer a paste for a GitHub and a Jenkins token, and for a Claude token only where one is any use, when nothing is stored", () => {
    expect(savedCredentials([], "own-licence", true).map((row) => [row.kind, row.pasteable])).toEqual([
      ["github", true],
      ["claude", true],
      ["jenkins", true]
    ]);
    expect(savedCredentials([], "gateway", false).map((row) => row.kind)).toEqual(["github", "jenkins"]);
  });

  it("should offer removal of every stored kind, and never a paste for a sign-in a pod makes, when all are stored", () => {
    const rows = savedCredentials(
      ["github", "azure", "claude", "jenkins", "atlassian"].map((kind) => stored(kind as CredentialKind)),
      "gateway",
      false
    );

    expect(rows.map((row) => [row.kind, row.stored, row.pasteable])).toEqual([
      ["github", true, true],
      ["azure", true, false],
      ["claude", true, false],
      ["jenkins", true, true],
      ["atlassian", true, false]
    ]);
  });

  it("should leave out the CLAUDE.md and the git identity when they are stored, since they have sections of their own", () => {
    expect(savedCredentials([stored("claude_md"), stored("git_identity")], "gateway", false).map((row) => row.kind)).toEqual(["github", "jenkins"]);
  });

  it.each([
    ["claude", "own-licence", "cannot answer again until you paste a new one"],
    ["azure", "gateway", "cannot answer again until you sign in to Azure again"],
    ["github", "gateway", "cannot reach GitHub until you paste a new token or sign in to GitHub again"],
    ["azure", "own-licence", "stops using it the next time it starts"],
    ["claude", "gateway", "stops using it the next time it starts"],
    ["atlassian", "gateway", "stops using it the next time it starts"]
  ] as const)("should say what removing a %s credential ends when the assistant is on the %s route", (kind, route, words) => {
    expect(savedCredentials([stored(kind)], route, true).find((row) => row.kind === kind)?.removeQuestion).toContain(words);
  });
});

describe("savedCredentialsData", () => {
  it("should say why there are no rows when the hub cannot read the credentials", () => {
    expect(savedCredentialsData({ available: false, reason: "no store", claudeTokenUsable: false }, "gateway")).toEqual({ rows: [], unavailable: "no store" });
  });
});
