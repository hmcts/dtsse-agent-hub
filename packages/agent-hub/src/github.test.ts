import { describe, expect, it } from "vitest";
import { GITHUB_OWNER_RE, GITHUB_REPO_RE, ghAuthToken, ghSaid } from "./github.ts";

describe("ghAuthToken", () => {
  const TOKEN = `${"gh"}o_abcdefghijklmnopqrstuvwxyz`;

  it("should read the token from gh with the timeout given", async () => {
    const asked: unknown[] = [];
    const run = async (cmd: string, args: string[], opts: { env: object; timeoutMs: number }) => {
      asked.push([cmd, ...args, opts.timeoutMs]);
      return { code: 0, stdout: `${TOKEN}\n`, stderr: "" };
    };

    expect(await ghAuthToken(run, {}, 1234)).toBe(TOKEN);
    expect(asked).toEqual([["gh", "auth", "token", "--hostname", "github.com", 1234]]);
  });

  it("should read none when gh fails, prints nothing or prints more than a token", async () => {
    expect(await ghAuthToken(async () => ({ code: 1, stdout: TOKEN, stderr: "not logged in" }), {}, 1)).toBeNull();
    expect(await ghAuthToken(async () => ({ code: 0, stdout: "\n", stderr: "" }), {}, 1)).toBeNull();
    expect(await ghAuthToken(async () => ({ code: 0, stdout: "two words", stderr: "" }), {}, 1)).toBeNull();
  });
});

describe("GITHUB_REPO_RE", () => {
  it.each(["hmcts/cft-workspace", "hmcts/.github", "hmcts/a.b_c-d", "x/.x", "a-b/.." + "x"])("should accept %s", (repo) => {
    expect(GITHUB_REPO_RE.test(repo)).toBe(true);
  });

  it.each(["hmcts/.", "hmcts/..", "-hmcts/x", "hmcts", "hmcts/x/y", "hmcts/x y", "hmcts/"])("should refuse %s", (repo) => {
    expect(GITHUB_REPO_RE.test(repo)).toBe(false);
  });

  it("should take an owner of at most 39 characters", () => {
    expect(GITHUB_OWNER_RE.test("a".repeat(39))).toBe(true);
    expect(GITHUB_OWNER_RE.test("a".repeat(40))).toBe(false);
  });
});

describe("ghSaid", () => {
  it("should add the first line gh wrote that is not JSON, without its colours", () => {
    expect(ghSaid({ code: 1, stdout: '{"x":1}', stderr: "\n  \u001b[31mHTTP 404: Not Found\u001b[0m\nmore" }, "GitHub refused", 300)).toBe(
      "GitHub refused: HTTP 404: Not Found"
    );
  });

  it("should say only what it was given when gh wrote nothing", () => {
    expect(ghSaid({ code: 1, stdout: "", stderr: "" }, "GitHub refused", 300)).toBe("GitHub refused");
  });

  it("should keep the line within the limit", () => {
    expect(ghSaid({ code: 1, stdout: "", stderr: "x".repeat(500) }, "GitHub refused", 50)).toHaveLength(50);
  });
});
