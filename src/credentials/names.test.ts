import { describe, expect, it } from "vitest";
import { CREDENTIAL_KINDS, InvalidCredentialOwner, isCredentialKind, isDevOid, isEntraOid, secretName } from "./names.ts";

const OID = "0f8a3c1e-1b2d-4e5f-8a9b-0c1d2e3f4a5b";

describe("secretName", () => {
  it.each(CREDENTIAL_KINDS)("should name the %s credential u-<oid>-<kind> when the owner is an Entra oid", (kind) => {
    expect(secretName(OID, kind)).toBe(`u-${OID}-${kind.replaceAll("_", "-")}`);
  });

  it("should name a CLAUDE.md with a hyphen when the kind has an underscore a vault name refuses", () => {
    expect(secretName(OID, "claude_md")).toBe(`u-${OID}-claude-md`);
    expect(secretName(OID, "claude_md")).toMatch(/^[0-9a-zA-Z-]{1,127}$/);
  });

  it("should name a development identity's credential the same way when the owner is a persona", () => {
    expect(secretName("dev-alice", "github")).toBe("u-dev-alice-github");
  });

  it("should only use characters a Key Vault secret name allows when the owner is valid", () => {
    expect(secretName(OID, "azure")).toMatch(/^[0-9a-zA-Z-]{1,127}$/);
    expect(secretName(`dev-${"a".repeat(64)}`, "claude")).toMatch(/^[0-9a-zA-Z-]{1,127}$/);
  });

  it.each([
    ["an empty oid", ""],
    ["an uppercase GUID, which Entra never issues", OID.toUpperCase()],
    ["a GUID without hyphens", OID.replaceAll("-", "")],
    ["an oid with a character a vault name refuses", "dev-alice_smith"],
    ["an oid with a path separator", `${OID}/x`],
    ["a dev prefix and nothing else", "dev-"],
    ["a dev oid that is too long", `dev-${"a".repeat(65)}`]
  ])("should refuse %s when asked for a name", (_label, oid) => {
    expect(() => secretName(oid, "github")).toThrow(InvalidCredentialOwner);
  });

  it("should refuse a kind it does not know when the caller passes one through", () => {
    expect(() => secretName(OID, "ssh" as never)).toThrow(InvalidCredentialOwner);
  });
});

describe("isCredentialKind", () => {
  it.each([
    ["github", true],
    ["azure", true],
    ["claude", true],
    ["bedrock", true],
    ["jenkins", true],
    ["claude_md", true],
    ["git_identity", true],
    ["atlassian", true],
    ["claude-md", false],
    ["GitHub", false],
    ["", false],
    [undefined, false],
    [7, false]
  ])("should answer %s → %s when checking a kind", (value, expected) => {
    expect(isCredentialKind(value)).toBe(expected);
  });
});

describe("isEntraOid and isDevOid", () => {
  it("should tell an Entra oid from a development identity when given each", () => {
    expect(isEntraOid(OID)).toBe(true);
    expect(isDevOid(OID)).toBe(false);
    expect(isEntraOid("dev-alice")).toBe(false);
    expect(isDevOid("dev-alice")).toBe(true);
  });
});
