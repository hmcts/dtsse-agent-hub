import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkCredential, MAX_CREDENTIAL_LENGTH } from "./validate.ts";

function azureCache(cache: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(cache), "utf8")).toString("base64");
}

const ACCOUNT = { "home.env.realm": { username: "a.person@justice.gov.uk", home_account_id: "home" } };

describe("checkCredential for github", () => {
  it.each([
    ["a classic personal token", `ghp_${"a".repeat(36)}`],
    ["an OAuth token", `gho_${"B1".repeat(18)}`],
    ["a server token", `ghs_${"c".repeat(20)}`],
    ["a user-to-server token", `ghu_${"d".repeat(40)}`],
    ["a fine-grained token", `github_pat_11ABC_${"e".repeat(70)}`]
  ])("should accept %s when it matches GitHub's format", (_label, value) => {
    expect(checkCredential("github", value)).toEqual({ ok: true, value, accountLabel: null });
  });

  it("should trim surrounding whitespace when the paste carries a newline", () => {
    const value = `ghp_${"a".repeat(36)}`;

    expect(checkCredential("github", `  ${value}\n`)).toEqual({ ok: true, value, accountLabel: null });
  });

  it.each([
    ["an unknown prefix", `ghx_${"a".repeat(36)}`],
    ["a token that is too short", "ghp_abc"],
    ["a token with a space in it", `ghp_${"a".repeat(18)} ${"a".repeat(18)}`],
    ["a Claude token", `sk-ant-oat01-${"a".repeat(40)}`]
  ])("should refuse %s without echoing it when it does not match", (_label, value) => {
    const checked = checkCredential("github", value);

    expect(checked).toMatchObject({ ok: false, error: expect.stringContaining("GitHub token") });
    expect(JSON.stringify(checked)).not.toContain(value);
  });
});

describe("checkCredential for claude", () => {
  it("should accept the OAuth token claude setup-token prints when it is pasted", () => {
    const value = `sk-ant-oat01-${"Ab_-".repeat(20)}`;

    expect(checkCredential("claude", value)).toEqual({ ok: true, value, accountLabel: null });
  });

  it.each([
    ["a GitHub token", `ghp_${"a".repeat(36)}`],
    ["a token that is too short", "sk-ant-abc"],
    ["a token with a dot in it", `sk-ant-${"a".repeat(20)}.b`]
  ])("should refuse %s when it is not a Claude token", (_label, value) => {
    expect(checkCredential("claude", value)).toMatchObject({ ok: false, error: expect.stringContaining("Claude token") });
  });
});

describe("checkCredential for azure", () => {
  it("should accept a gzipped MSAL cache and label it with the account when it has one", () => {
    const value = azureCache({ Account: ACCOUNT, AccessToken: {}, RefreshToken: {} });

    expect(checkCredential("azure", value)).toEqual({ ok: true, value, accountLabel: "a.person@justice.gov.uk" });
  });

  it.each([
    ["an empty Account section", { Account: {} }],
    ["accounts without usernames", { Account: { a: { home_account_id: "x" }, b: null } }],
    ["an Account section that is not an object", { Account: "nobody" }]
  ])("should accept the cache with no label when it has %s", (_label, cache) => {
    expect(checkCredential("azure", azureCache(cache))).toMatchObject({ ok: true, accountLabel: null });
  });

  it.each([
    ["text that is not base64", "not base64!"],
    ["base64 of something that is not gzip", Buffer.from("plain text").toString("base64")],
    ["base64 with the wrong padding", "abcde"],
    ["gzip of something that is not JSON", gzipSync(Buffer.from("not json")).toString("base64")]
  ])("should refuse %s when it is not a token cache", (_label, value) => {
    expect(checkCredential("azure", value)).toMatchObject({ ok: false, error: expect.stringContaining("Azure token cache") });
  });

  it.each([
    ["a cache with no Account section", { AccessToken: {} }],
    ["a JSON array", [{ Account: ACCOUNT }]],
    ["JSON null", null]
  ])("should refuse %s when it has no Account section", (_label, cache) => {
    expect(checkCredential("azure", azureCache(cache))).toMatchObject({ ok: false, error: expect.stringContaining("Account") });
  });

  it("should refuse a cache that expands past the limit when gunzipped", () => {
    const bomb = gzipSync(Buffer.from(JSON.stringify({ Account: {}, pad: "a".repeat(2 * 1024 * 1024) }))).toString("base64");

    expect(bomb.length).toBeLessThan(MAX_CREDENTIAL_LENGTH);
    expect(checkCredential("azure", bomb)).toMatchObject({ ok: false });
  });
});

describe("checkCredential limits", () => {
  it.each(["github", "azure", "claude"] as const)("should refuse a %s value over the length limit when it is too long", (kind) => {
    expect(checkCredential(kind, "a".repeat(MAX_CREDENTIAL_LENGTH + 1))).toMatchObject({
      ok: false,
      error: expect.stringContaining(String(MAX_CREDENTIAL_LENGTH))
    });
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["something that is not a string", 42]
  ])("should ask for a value when given %s", (_label, value) => {
    expect(checkCredential("github", value)).toMatchObject({ ok: false, error: expect.stringContaining("paste") });
  });
});
