import { describe, expect, it } from "vitest";
import {
  DOCMOSIS_LIBRARY_ID,
  FORCED_REFRESH_MIN_MS,
  forcedTooSoon,
  INDEX_REFRESH_PENDING_MS,
  INDEX_REVALIDATE_MS,
  type IndexEntry,
  indexAnswerBody,
  isLibraryPath,
  type LibraryRow,
  libraryStatus,
  MAX_INDEX_ENTRIES,
  refreshDecision,
  storedEntriesBytes
} from "./docmosis-library.ts";

const NOW = new Date("2026-11-18T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SHA = "a".repeat(40);
const BLOB = "b".repeat(40);

function row(overrides: Partial<LibraryRow> = {}): LibraryRow {
  return {
    ownerOid: "oid-a",
    commitSha: SHA,
    entryCount: 2,
    checkedAt: ago(60_000),
    refreshId: null,
    refreshRequestedAt: null,
    refreshForced: false,
    error: null,
    detail: null,
    ssoUrl: null,
    resetAt: null,
    ...overrides
  };
}

describe("DOCMOSIS_LIBRARY_ID", () => {
  it("should name the one library as owner/repo@ref:path", () => {
    expect(DOCMOSIS_LIBRARY_ID).toBe("hmcts/rdo-docmosis@HEAD:Templates");
  });
});

describe("isLibraryPath", () => {
  it.each(["Templates/Base/CV-SPC-CLM-ENG-00001.docx", "Templates/a.DOCX", "Templates/AAT/Sub folder/Claim form (v2).docx", "Templates/.hidden/x.docx"])(
    "should accept %s",
    (path) => {
      expect(isLibraryPath(path)).toBe(true);
    }
  );

  it.each([
    ["outside the folder", "Other/a.docx"],
    ["the folder's name alone as a prefix", "TemplatesX/a.docx"],
    ["a file that is not a .docx", "Templates/a.doc"],
    ["a Word lock file", "Templates/Base/~$claim.docx"],
    ["an empty segment", "Templates//a.docx"],
    ["a dot segment", "Templates/./a.docx"],
    ["a dot-dot segment", "Templates/../a.docx"],
    ["a backslash", "Templates/Base\\a.docx"],
    ["a control character", "Templates/a\u0007.docx"],
    ["a delete character", "Templates/a\u007f.docx"],
    ["more than 400 characters", `Templates/${"x".repeat(391)}.docx`],
    ["a number", 7]
  ])("should refuse %s", (_label, path) => {
    expect(isLibraryPath(path)).toBe(false);
  });

  it("should accept a path of exactly 400 characters", () => {
    expect(isLibraryPath(`Templates/${"x".repeat(385)}.docx`)).toBe(true);
  });
});

describe("indexAnswerBody", () => {
  const entries: IndexEntry[] = [
    ["Templates/a.docx", BLOB, 10],
    ["Templates/b.docx", BLOB, 0]
  ];

  it("should take a new index with an ETag, a weak one, or none", () => {
    expect(indexAnswerBody.safeParse({ commit: SHA, etag: '"abc"', entries }).success).toBe(true);
    expect(indexAnswerBody.safeParse({ commit: SHA, etag: 'W/"abc"', entries }).success).toBe(true);
    expect(indexAnswerBody.safeParse({ commit: SHA, etag: null, entries: [] }).success).toBe(true);
  });

  it.each([
    ["a commit that is not 40 hex", { commit: "abc", etag: null, entries }],
    ["an uppercase commit", { commit: SHA.toUpperCase(), etag: null, entries }],
    ["an ETag without quotes", { commit: SHA, etag: "abc", entries }],
    ["an ETag with a quote inside", { commit: SHA, etag: '"a"b"', entries }],
    ["an ETag over 200 characters", { commit: SHA, etag: `"${"a".repeat(199)}"`, entries }],
    ["a repeated path", { commit: SHA, etag: null, entries: [entries[0], entries[0]] }],
    ["a blob that is not a SHA-1", { commit: SHA, etag: null, entries: [["Templates/a.docx", "x", 1]] }],
    ["a negative size", { commit: SHA, etag: null, entries: [["Templates/a.docx", BLOB, -1]] }],
    ["a fractional size", { commit: SHA, etag: null, entries: [["Templates/a.docx", BLOB, 1.5]] }],
    ["an entry that is not a tuple", { commit: SHA, etag: null, entries: [{ path: "Templates/a.docx" }] }],
    ["a field the contract does not have", { commit: SHA, etag: null, entries, extra: 1 }]
  ])("should refuse %s", (_label, body) => {
    expect(indexAnswerBody.safeParse(body).success).toBe(false);
  });

  it("should refuse more than the entries an index holds, with one issue", () => {
    const result = indexAnswerBody.safeParse({
      commit: SHA,
      etag: null,
      entries: Array.from({ length: MAX_INDEX_ENTRIES + 1 }, (_, i) => [`Templates/${i}.docx`, BLOB, 1])
    });

    expect(result.success).toBe(false);
  });

  it("should take an unchanged index with or without an ETag", () => {
    expect(indexAnswerBody.parse({ unchanged: true })).toEqual({ unchanged: true });
    expect(indexAnswerBody.parse({ unchanged: true, etag: '"x"' })).toEqual({ unchanged: true, etag: '"x"' });
    expect(indexAnswerBody.safeParse({ unchanged: false }).success).toBe(false);
  });

  it("should take every failure, with what it may carry", () => {
    for (const error of ["signed_out", "sso", "not_found", "rate_limited", "failed"]) {
      expect(indexAnswerBody.safeParse({ error }).success).toBe(true);
    }
    expect(
      indexAnswerBody.safeParse({ error: "sso", detail: "Authorise it", sso_url: "https://github.com/orgs/hmcts/sso?authorization_request=1" }).success
    ).toBe(true);
    expect(indexAnswerBody.safeParse({ error: "rate_limited", reset_at: "2026-11-18T12:30:00.000Z" }).success).toBe(true);
  });

  it.each([
    ["an unknown reason", { error: "superseded" }],
    ["a detail over 300 characters", { error: "failed", detail: "x".repeat(301) }],
    ["an SSO page off github.com", { error: "sso", sso_url: "https://evil.example/github.com/" }],
    ["an SSO page that is not https", { error: "sso", sso_url: "http://github.com/orgs/hmcts/sso" }],
    ["a reset time that is not a time", { error: "rate_limited", reset_at: "soon" }]
  ])("should refuse a failure with %s", (_label, body) => {
    expect(indexAnswerBody.safeParse(body).success).toBe(false);
  });
});

describe("storedEntriesBytes", () => {
  it("should allow for the space Postgres prints after every comma", () => {
    const entries: IndexEntry[] = [
      ["Templates/a.docx", BLOB, 10],
      ["Templates/b.docx", BLOB, 0]
    ];
    const printed = `[["Templates/a.docx", "${BLOB}", 10], ["Templates/b.docx", "${BLOB}", 0]]`;

    expect(storedEntriesBytes(entries)).toBeGreaterThanOrEqual(printed.length);
    expect(storedEntriesBytes([])).toBe(2);
  });

  it("should count bytes rather than characters", () => {
    expect(storedEntriesBytes([["Templates/é.docx", BLOB, 1]])).toBe(new TextEncoder().encode(JSON.stringify([["Templates/é.docx", BLOB, 1]])).length + 3);
  });
});

describe("refreshDecision", () => {
  it("should ask when there is no row", () => {
    expect(refreshDecision(null, NOW, false)).toBe("ask");
  });

  it("should ask when there is no index yet or it has never been checked", () => {
    expect(refreshDecision(row({ commitSha: null, entryCount: 0 }), NOW, false)).toBe("ask");
    expect(refreshDecision(row({ checkedAt: null }), NOW, false)).toBe("ask");
  });

  it("should do nothing when the last check is recent", () => {
    expect(refreshDecision(row({ checkedAt: ago(INDEX_REVALIDATE_MS - 1) }), NOW, false)).toBe("none");
  });

  it("should ask when the last check is five minutes old", () => {
    expect(refreshDecision(row({ checkedAt: ago(INDEX_REVALIDATE_MS) }), NOW, false)).toBe("ask");
  });

  it("should ask when forced, however recent the last check", () => {
    expect(refreshDecision(row({ checkedAt: NOW }), NOW, true)).toBe("ask");
  });

  it("should join a check still pending, forced or not", () => {
    const pending = row({ refreshId: "r", refreshRequestedAt: ago(INDEX_REFRESH_PENDING_MS - 1) });

    expect(refreshDecision(pending, NOW, false)).toBe("join");
    expect(refreshDecision(pending, NOW, true)).toBe("join");
  });

  it("should ask again when the pending check is two minutes old and so lost", () => {
    expect(refreshDecision(row({ refreshId: "r", refreshRequestedAt: ago(INDEX_REFRESH_PENDING_MS), checkedAt: null }), NOW, false)).toBe("ask");
  });
});

describe("forcedTooSoon", () => {
  it("should refuse a forced check within 30 seconds of the last forced one", () => {
    expect(forcedTooSoon(row({ refreshForced: true, refreshRequestedAt: ago(FORCED_REFRESH_MIN_MS - 1) }), NOW)).toBe(true);
  });

  it("should allow one 30 seconds after", () => {
    expect(forcedTooSoon(row({ refreshForced: true, refreshRequestedAt: ago(FORCED_REFRESH_MIN_MS) }), NOW)).toBe(false);
  });

  it("should allow one when the last check asked for was not forced, or none was", () => {
    expect(forcedTooSoon(row({ refreshForced: false, refreshRequestedAt: ago(1) }), NOW)).toBe(false);
    expect(forcedTooSoon(row({ refreshForced: true, refreshRequestedAt: null }), NOW)).toBe(false);
    expect(forcedTooSoon(null, NOW)).toBe(false);
  });

  it("should never refuse one while a check is pending, which it joins", () => {
    expect(forcedTooSoon(row({ refreshForced: true, refreshId: "r", refreshRequestedAt: ago(1) }), NOW)).toBe(false);
  });
});

describe("libraryStatus", () => {
  it("should describe a library with no row", () => {
    expect(libraryStatus(null, "waking", NOW)).toEqual({
      library: "hmcts/rdo-docmosis@HEAD:Templates",
      owner: "hmcts",
      repo: "rdo-docmosis",
      ref: "HEAD",
      path: "Templates",
      pod: "waking",
      commit: null,
      entry_count: 0,
      checked_at: null,
      refreshing: false,
      failure: null
    });
  });

  it("should describe an index being checked", () => {
    const status = libraryStatus(row({ refreshId: "r", refreshRequestedAt: ago(1) }), "ok", NOW);

    expect(status).toMatchObject({ pod: "ok", commit: SHA, entry_count: 2, checked_at: ago(60_000).toISOString(), refreshing: true, failure: null });
  });

  it("should give a failure with only what it carries", () => {
    expect(libraryStatus(row({ error: "signed_out" }), "ok", NOW).failure).toEqual({ reason: "signed_out" });
    expect(libraryStatus(row({ error: "rate_limited", detail: "Used up", resetAt: new Date("2026-11-18T13:00:00.000Z") }), "ok", NOW).failure).toEqual({
      reason: "rate_limited",
      detail: "Used up",
      reset_at: "2026-11-18T13:00:00.000Z"
    });
    expect(libraryStatus(row({ error: "sso", ssoUrl: "https://github.com/orgs/hmcts/sso" }), "ok", NOW).failure).toEqual({
      reason: "sso",
      sso_url: "https://github.com/orgs/hmcts/sso"
    });
  });

  it("should give no failure for a reason it does not know", () => {
    expect(libraryStatus(row({ error: "other" }), "ok", NOW).failure).toBeNull();
  });

  it("should count no entries while there is no index", () => {
    expect(libraryStatus(row({ commitSha: null, entryCount: 5 }), "ok", NOW).entry_count).toBe(0);
  });
});
