import { describe, expect, it } from "vitest";
import { checkGitIdentity, MAX_GIT_EMAIL_LENGTH, MAX_GIT_NAME_CHARACTERS, readGitIdentity } from "./git-identity.ts";

const json = (value: unknown) => JSON.stringify(value);

describe("checkGitIdentity", () => {
  it("should store both fields trimmed when a name and an email are given", () => {
    expect(checkGitIdentity(json({ name: "  Olive Owner ", email: " olive.owner@justice.gov.uk " }))).toEqual({
      ok: true,
      value: json({ name: "Olive Owner", email: "olive.owner@justice.gov.uk" })
    });
  });

  it.each([
    [{ name: "Olive" }, { name: "Olive" }],
    [{ email: "o@example.com" }, { email: "o@example.com" }],
    [{ name: "Olive", email: "  " }, { name: "Olive" }],
    [{ name: null, email: "o@example.com" }, { email: "o@example.com" }]
  ])("should store only the fields set when %j leaves one out", (given, stored) => {
    expect(checkGitIdentity(json(given))).toEqual({ ok: true, value: json(stored) });
  });

  it.each([undefined, 7, "not json", "[]", "null", '"text"'])("should refuse %j when it is not a JSON object", (raw) => {
    expect(checkGitIdentity(raw)).toEqual({ ok: false, error: 'a git identity is JSON like {"name": "…", "email": "…"}' });
  });

  it("should refuse it when it has a field other than a name and an email", () => {
    expect(checkGitIdentity(json({ name: "Olive", signingkey: "x" }))).toEqual({ ok: false, error: "a git identity has only a name and an email" });
  });

  it.each([{ name: 7 }, { email: ["o@example.com"] }])("should refuse %j when a field is not text", (given) => {
    expect(checkGitIdentity(json(given))).toEqual({ ok: false, error: "a git identity's name and email are text" });
  });

  it.each([{}, { name: "", email: " " }])("should ask for a field when %j sets neither", (given) => {
    expect(checkGitIdentity(json(given))).toEqual({ ok: false, error: "set a name or an email, or clear the git identity" });
  });

  it.each([
    "Olive <o@example.com>",
    "Olive\nOwner",
    "Olive\u0000",
    "\ud800Olive"
  ])("should refuse the name %j when it would corrupt the author line", (name) => {
    expect(checkGitIdentity(json({ name }))).toEqual({ ok: false, error: "the git name cannot hold control characters or < >" });
  });

  it("should accept a name of the most characters when they are counted as code points", () => {
    expect(checkGitIdentity(json({ name: "😀".repeat(MAX_GIT_NAME_CHARACTERS) })).ok).toBe(true);
  });

  it("should refuse the name when it is over the character limit", () => {
    expect(checkGitIdentity(json({ name: "a".repeat(MAX_GIT_NAME_CHARACTERS + 1) }))).toEqual({
      ok: false,
      error: `the git name is at most ${MAX_GIT_NAME_CHARACTERS} characters`
    });
  });

  it("should refuse the email when it is over the length limit", () => {
    const email = `${"a".repeat(MAX_GIT_EMAIL_LENGTH - "@example.com".length + 1)}@example.com`;
    expect(checkGitIdentity(json({ email }))).toEqual({ ok: false, error: `the git email is at most ${MAX_GIT_EMAIL_LENGTH} characters` });
  });

  it("should accept the email when it is exactly the length limit", () => {
    const email = `${"a".repeat(MAX_GIT_EMAIL_LENGTH - "@example.com".length)}@example.com`;
    expect(checkGitIdentity(json({ email })).ok).toBe(true);
  });

  it.each([
    "olive",
    "olive@",
    "@example.com",
    "olive@example",
    "o live@example.com",
    "o@@example.com",
    "<o@example.com>",
    "o@example..com",
    "o@.com"
  ])("should refuse the email %j when it is not a plausible address", (email) => {
    expect(checkGitIdentity(json({ email }))).toEqual({ ok: false, error: "that is not an email address" });
  });

  it.each([
    "4242+oliveo@users.noreply.github.com",
    "olive.owner@justice.gov.uk",
    "o@x.io"
  ])("should accept the email %j when it is a plausible address", (email) => {
    expect(checkGitIdentity(json({ email })).ok).toBe(true);
  });
});

describe("readGitIdentity", () => {
  it("should give no fields when nothing is stored", () => {
    expect(readGitIdentity(undefined)).toEqual({});
  });

  it("should give the stored fields when the value is a git identity", () => {
    expect(readGitIdentity(json({ name: "Olive", email: "o@example.com" }))).toEqual({ name: "Olive", email: "o@example.com" });
  });

  it("should give no fields when the stored value cannot be read", () => {
    expect(readGitIdentity("{")).toEqual({});
  });
});
