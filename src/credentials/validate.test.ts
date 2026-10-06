import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkAzureCacheOwner, checkCredential, decodeAzureCache, MAX_CREDENTIAL_LENGTH } from "./validate.ts";

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

describe("checkCredential for bedrock", () => {
  it.each([
    ["a long-term key", `ABSK${"QmVkcm9jaw+/=".repeat(10)}`],
    ["a short-term key", `bedrock-api-key-${"YmVkcm9jay5hbWF6b25hd3MuY29t".repeat(20)}`],
    ["a key of another shape at the shortest length", "x".repeat(20)],
    ["a key at the longest length", "k".repeat(4096)]
  ])("should accept %s when it is printable ASCII without spaces", (_label, value) => {
    expect(checkCredential("bedrock", value)).toEqual({ ok: true, value, accountLabel: null });
  });

  it("should trim surrounding whitespace when the paste carries a newline", () => {
    const value = `ABSK${"a".repeat(40)}`;

    expect(checkCredential("bedrock", `\n ${value} \n`)).toEqual({ ok: true, value, accountLabel: null });
  });

  it.each([
    ["a key that is too short", "ABSK12345"],
    ["a key that is too long", "k".repeat(4097)],
    ["a key with a space in it", `ABSK${"a".repeat(20)} ${"a".repeat(20)}`],
    ["a key with a tab in it", `ABSK${"a".repeat(20)}\t${"a".repeat(20)}`],
    ["a key with a character outside ASCII", `ABSK${"a".repeat(20)}é`]
  ])("should refuse %s without echoing it when it is not a key", (_label, value) => {
    const checked = checkCredential("bedrock", value);

    expect(checked).toEqual({ ok: false, error: expect.stringContaining("Amazon Bedrock API key") });
    expect(JSON.stringify(checked)).not.toContain(value);
  });

  it.each([
    ["a GitHub token", `ghp_${"a".repeat(36)}`, "GitHub token"],
    ["a fine-grained GitHub token", `github_pat_11ABC_${"e".repeat(70)}`, "GitHub token"],
    ["a Claude token", `sk-ant-oat01-${"a".repeat(40)}`, "Claude token"],
    ["an AWS access key id", "AKIAIOSFODNN7EXAMPLE", "access key id"],
    ["a temporary AWS access key id", "ASIAIOSFODNN7EXAMPLE", "access key id"]
  ])("should say what was pasted when it is %s", (_label, value, named) => {
    const checked = checkCredential("bedrock", value);

    expect(checked).toEqual({ ok: false, error: expect.stringContaining(named) });
    expect(JSON.stringify(checked)).not.toContain(value);
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
  it.each(["github", "azure", "claude", "bedrock"] as const)("should refuse a %s value over the length limit when it is too long", (kind) => {
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

describe("decodeAzureCache", () => {
  it("should decode base64 of gzipped JSON when it is an object", () => {
    expect(decodeAzureCache(azureCache({ Account: ACCOUNT }))).toEqual({ Account: ACCOUNT });
  });

  it.each([
    ["not base64", "not base64!"],
    ["base64 of something not gzipped", Buffer.from("plain").toString("base64")],
    ["gzipped JSON that is not an object", azureCache([1, 2])],
    ["gzipped JSON null", azureCache(null)],
    ["gzipped text that is not JSON", gzipSync(Buffer.from("{")).toString("base64")]
  ])("should give nothing when it is %s", (_label, value) => {
    expect(decodeAzureCache(value)).toBeUndefined();
  });
});

describe("checkAzureCacheOwner", () => {
  const OID = "a1b2c3d4-0000-4000-8000-000000000001";
  const TID = "531ff96d-0ae9-462a-8d2d-bec7c0b42082";

  function account(home: unknown) {
    return { username: "a.person@justice.gov.uk", home_account_id: home };
  }

  it("should accept a cache whose every account is the owner's in this tenant", () => {
    const cache = azureCache({ Account: { one: account(`${OID}.${TID}`), two: account(`${OID.toUpperCase()}.${TID}`) } });

    expect(checkAzureCacheOwner(` ${cache}\n`, OID, TID)).toEqual({ ok: true });
  });

  it.each([
    ["someone else's account", { a: account(`b1b2c3d4-0000-4000-8000-000000000002.${TID}`) }],
    ["the owner's account in another tenant", { a: account(`${OID}.99999999-9999-9999-9999-999999999999`) }],
    ["the owner's account beside someone else's", { a: account(`${OID}.${TID}`), b: account(`other.${TID}`) }],
    ["an account with no home_account_id", { a: { username: "x" } }],
    ["a home_account_id that is not a string", { a: account(42) }],
    ["a home_account_id with more parts", { a: account(`${OID}.${TID}.extra`) }],
    ["a null account", { a: null }],
    ["no accounts", {}]
  ])("should refuse a cache holding %s", (_label, accounts) => {
    expect(checkAzureCacheOwner(azureCache({ Account: accounts }), OID, TID)).toMatchObject({ ok: false, reason: "not-owner" });
  });

  it.each([
    ["not a cache", "nope"],
    ["a cache without an Account section", azureCache({ AccessToken: {} })],
    ["a cache whose Account section is null", azureCache({ Account: null })],
    ["not a string", 42]
  ])("should call it malformed when it is %s", (_label, value) => {
    expect(checkAzureCacheOwner(value, OID, TID)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it.each([undefined, " "])("should refuse to judge when the hub's tenant is %j", (tenant) => {
    expect(checkAzureCacheOwner(azureCache({ Account: { a: account(`${OID}.${TID}`) } }), OID, tenant)).toMatchObject({ ok: false, reason: "unconfigured" });
  });
});

describe("checkCredential for jenkins", () => {
  it.each([
    ["the hex token Jenkins makes", "11a2b3c4d5e6f708192a3b4c5d6e7f8091"],
    ["20 characters", "a".repeat(20)],
    ["200 characters", "Z".repeat(200)]
  ])("should accept %s and trim it", (_label, value) => {
    expect(checkCredential("jenkins", ` ${value}\n`)).toEqual({ ok: true, value, accountLabel: null });
  });

  it.each([
    ["19 characters", "a".repeat(19)],
    ["201 characters", "a".repeat(201)],
    ["a space inside", `${"a".repeat(12)} ${"b".repeat(12)}`],
    ["a character that is not ASCII", `${"a".repeat(20)}é`]
  ])("should refuse a value with %s", (_label, value) => {
    expect(checkCredential("jenkins", value)).toEqual({ ok: false, error: expect.stringContaining("20 to 200 printable characters") });
  });

  it.each([
    ["GitHub token", `ghp_${"A1b2".repeat(9)}`],
    ["Claude token", `sk-ant-oat01-${"Qw_-".repeat(12)}`],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"]
  ])("should say a %s is not a Jenkins API token", (kind, value) => {
    expect(checkCredential("jenkins", value)).toEqual({ ok: false, error: `that is a${kind.startsWith("AWS") ? "n" : ""} ${kind}, not a Jenkins API token` });
  });

  it("should ask for a token when none is pasted", () => {
    expect(checkCredential("jenkins", "  ")).toEqual({ ok: false, error: "paste a Jenkins API token" });
  });
});

describe("checkCredential for claude_md", () => {
  it("should keep the text as written, untrimmed and unlabelled, when it is a valid CLAUDE.md", () => {
    expect(checkCredential("claude_md", "  # Notes\n\nBe brief.\n")).toEqual({ ok: true, value: "  # Notes\n\nBe brief.\n", accountLabel: null });
  });

  it("should refuse it with the CLAUDE.md byte limit's reason when it is over that", () => {
    expect(checkCredential("claude_md", "é".repeat(MAX_CREDENTIAL_LENGTH / 2 + 1))).toMatchObject({ ok: false, error: expect.stringContaining("bytes") });
  });

  it("should refuse it with the CLAUDE.md check's reason when it holds a control character", () => {
    expect(checkCredential("claude_md", "a\u0000")).toEqual({ ok: false, error: "your CLAUDE.md can only hold printable text, tabs and new lines" });
  });
});

describe("checkCredential for git_identity", () => {
  it("should store the JSON of the fields set, unlabelled, when it is a valid git identity", () => {
    expect(checkCredential("git_identity", '{"name":" Olive ","email":""}')).toEqual({ ok: true, value: '{"name":"Olive"}', accountLabel: null });
  });

  it("should refuse it with the git identity check's reason when the email is not an address", () => {
    expect(checkCredential("git_identity", '{"email":"olive"}')).toEqual({ ok: false, error: "that is not an email address" });
  });
});
