import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashLaunchToken, isWellFormedLaunchToken, LAUNCH_TOKEN_PREFIX, launchTokenMatches, looksLikeLaunchToken, mintLaunchToken } from "./launch-token.ts";

describe("mintLaunchToken", () => {
  it("should mint ahv_ and 32 random bytes as base64url when called", () => {
    const { token } = mintLaunchToken();

    expect(token).toMatch(/^ahv_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice(LAUNCH_TOKEN_PREFIX.length), "base64url")).toHaveLength(32);
  });

  it("should keep the SHA-256 of the token as its hash when it mints one", () => {
    const { token, hash } = mintLaunchToken(() => Buffer.alloc(32, 7));

    expect(Buffer.from(hash)).toEqual(createHash("sha256").update(token).digest());
    expect(token).toBe(`ahv_${Buffer.alloc(32, 7).toString("base64url")}`);
  });

  it("should mint a different token each time when the bytes are random", () => {
    expect(mintLaunchToken().token).not.toBe(mintLaunchToken().token);
  });
});

describe("launchTokenMatches", () => {
  const { token, hash } = mintLaunchToken();

  it("should accept the token when the stored hash is its own", () => {
    expect(launchTokenMatches(token, hash)).toBe(true);
  });

  it("should refuse another token when the stored hash is not its", () => {
    expect(launchTokenMatches(mintLaunchToken().token, hash)).toBe(false);
  });

  it.each([
    ["no stored hash", token, null],
    ["a stored hash of the wrong length", token, new Uint8Array(16)],
    ["a malformed token", `${token}x`, hashLaunchToken(`${token}x`)],
    ["an Entra-shaped token", "eyJhbGciOiJSUzI1NiJ9.e30.sig", hashLaunchToken("eyJhbGciOiJSUzI1NiJ9.e30.sig")]
  ])("should refuse when there is %s", (_label, candidate, stored) => {
    expect(launchTokenMatches(candidate, stored)).toBe(false);
  });
});

describe("looksLikeLaunchToken and isWellFormedLaunchToken", () => {
  it("should tell a launch token from an Entra token by its prefix when it is read", () => {
    expect(looksLikeLaunchToken("ahv_anything")).toBe(true);
    expect(looksLikeLaunchToken("eyJ0eXAiOiJKV1QifQ")).toBe(false);
  });

  it("should accept only the minted shape when it is checked", () => {
    expect(isWellFormedLaunchToken(mintLaunchToken().token)).toBe(true);
    expect(isWellFormedLaunchToken("ahv_short")).toBe(false);
    expect(isWellFormedLaunchToken(`ahv_${"a".repeat(42)}+`)).toBe(false);
  });
});
