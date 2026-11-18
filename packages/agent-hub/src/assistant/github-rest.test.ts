import { describe, expect, it } from "vitest";
import { blob, commitCheck, errorFor, type FetchLike, type GithubRest, GithubRestError, githubPage, githubToken, isGitRef, templates } from "./github-rest.ts";

const TOKEN = "gho_abcdefghijklmnopqrstuvwxyz";
const COMMIT = "c".repeat(40);
const sha = (n: number) => n.toString(16).padStart(40, "0");

type Call = { url: string; headers: Record<string, string> };

/** A fetch answering each URL from `routes`, by the first key the URL contains, and recording what it was asked. */
function fakeFetch(routes: Record<string, (call: Call) => Response | Promise<Response>>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, headers: init.headers };
    calls.push(call);
    const key = Object.keys(routes).find((candidate) => url.includes(candidate));
    if (key === undefined) {
      return new Response("not routed", { status: 500 });
    }
    return await (routes[key] as (call: Call) => Response | Promise<Response>)(call);
  };
  return { fetch, calls };
}

const rest = (fetch: FetchLike): GithubRest => ({ fetch, token: TOKEN });

async function failureOf(call: Promise<unknown>) {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(GithubRestError);
  return (error as GithubRestError).failure;
}

describe("githubToken", () => {
  it("should read the token from gh, and nothing when gh has none", async () => {
    const asked: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      asked.push([cmd, ...args]);
      return { code: 0, stdout: `${TOKEN}\n`, stderr: "" };
    };

    expect(await githubToken(run, {})).toBe(TOKEN);
    expect(asked).toEqual([["gh", "auth", "token", "--hostname", "github.com"]]);
    expect(await githubToken(async () => ({ code: 1, stdout: "", stderr: "not logged in" }), {})).toBeNull();
    expect(await githubToken(async () => ({ code: 0, stdout: "two words", stderr: "" }), {})).toBeNull();
  });
});

describe("isGitRef", () => {
  it("should take HEAD and branch names, and refuse a climb or an edge slash", () => {
    expect(isGitRef("HEAD")).toBe(true);
    expect(isGitRef("feature/x-1.2")).toBe(true);
    expect(isGitRef("a/../b")).toBe(false);
    expect(isGitRef("/a")).toBe(false);
    expect(isGitRef("a/")).toBe(false);
    expect(isGitRef("a b")).toBe(false);
  });
});

describe("commitCheck", () => {
  it("should send the ETag and read a 304 as unchanged", async () => {
    const { fetch, calls } = fakeFetch({ "/commits/HEAD": () => new Response(null, { status: 304, headers: { etag: '"e1"' } }) });

    expect(await commitCheck(rest(fetch), "hmcts", "rdo-docmosis", "HEAD", '"e1"')).toEqual({ modified: false, etag: '"e1"' });
    expect(calls[0]?.url).toBe("https://api.github.com/repos/hmcts/rdo-docmosis/commits/HEAD");
    expect(calls[0]?.headers).toMatchObject({ accept: "application/vnd.github.sha", "if-none-match": '"e1"', authorization: `Bearer ${TOKEN}` });
  });

  it("should read the commit and its ETag, sending no If-None-Match without one", async () => {
    const { fetch, calls } = fakeFetch({ "/commits/": () => new Response(`${COMMIT}\n`, { headers: { etag: 'W/"e2"' } }) });

    expect(await commitCheck(rest(fetch), "hmcts", "rdo-docmosis", "HEAD", null)).toEqual({ modified: true, sha: COMMIT, etag: 'W/"e2"' });
    expect(calls[0]?.headers["if-none-match"]).toBeUndefined();
  });

  it("should fail when GitHub answers something that is not a commit", async () => {
    const { fetch } = fakeFetch({ "/commits/": () => new Response("<html>") });

    expect((await failureOf(commitCheck(rest(fetch), "hmcts", "rdo-docmosis", "HEAD", null))).error).toBe("failed");
  });

  it("should refuse a repository or ref that is not one without asking GitHub", async () => {
    const { fetch, calls } = fakeFetch({});

    expect((await failureOf(commitCheck(rest(fetch), "hmcts/x", "rdo", "HEAD", null))).error).toBe("failed");
    expect((await failureOf(commitCheck(rest(fetch), "hmcts", "..", "HEAD", null))).error).toBe("failed");
    expect((await failureOf(commitCheck(rest(fetch), "hmcts", "rdo", "../x", null))).error).toBe("failed");
    expect(calls).toEqual([]);
  });

  it("should fail as unreachable when the network does, without the token in what it says", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    };

    const failure = await failureOf(commitCheck(rest(fetch), "hmcts", "rdo-docmosis", "HEAD", null));

    expect(failure.error).toBe("failed");
    expect(failure.detail).toContain("can't reach GitHub");
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
  });
});

describe("templates", () => {
  it("should list the .docx files under the folder from one recursive tree, leaving out lock files, in path order", async () => {
    const { fetch, calls } = fakeFetch({
      "/git/trees/": () =>
        Response.json({
          sha: COMMIT,
          truncated: false,
          tree: [
            { path: "Templates/b.docx", type: "blob", sha: sha(2), size: 20 },
            { path: "Templates/a.DOCX", type: "blob", sha: sha(1), size: 10 },
            { path: "Templates/~$a.docx", type: "blob", sha: sha(3), size: 1 },
            { path: "Templates/notes.txt", type: "blob", sha: sha(4), size: 1 },
            { path: "Other/c.docx", type: "blob", sha: sha(5), size: 1 },
            { path: "Templates/Sub", type: "tree", sha: sha(6) }
          ]
        })
    });

    expect(await templates(rest(fetch), "hmcts", "rdo-docmosis", COMMIT, "Templates")).toEqual([
      { path: "Templates/a.DOCX", sha: sha(1), size: 10 },
      { path: "Templates/b.docx", sha: sha(2), size: 20 }
    ]);
    expect(calls.map((call) => call.url)).toEqual([`https://api.github.com/repos/hmcts/rdo-docmosis/git/trees/${COMMIT}?recursive=1`]);
  });

  it("should walk the folder one tree at a time when the recursive tree is truncated", async () => {
    const trees: Record<string, unknown> = {
      [`${COMMIT}?recursive=1`]: { sha: COMMIT, truncated: true, tree: [] },
      [COMMIT]: {
        sha: COMMIT,
        truncated: false,
        tree: [
          { path: "Templates", type: "tree", sha: sha(10) },
          { path: "README.md", type: "blob", sha: sha(11) }
        ]
      },
      [sha(10)]: {
        sha: sha(10),
        truncated: false,
        tree: [
          { path: "top.docx", type: "blob", sha: sha(12), size: 1 },
          { path: "Base", type: "tree", sha: sha(13) },
          { path: "AAT", type: "tree", sha: sha(14) }
        ]
      },
      [sha(13)]: { sha: sha(13), truncated: false, tree: [{ path: "claim.docx", type: "blob", sha: sha(15), size: 2 }] },
      [sha(14)]: { sha: sha(14), truncated: false, tree: [{ path: "Deep", type: "tree", sha: sha(16) }] },
      [sha(16)]: { sha: sha(16), truncated: false, tree: [{ path: "order.docx", type: "blob", sha: sha(17), size: 3 }] }
    };
    const { fetch } = fakeFetch({ "/git/trees/": ({ url }) => Response.json(trees[url.slice(url.lastIndexOf("/") + 1)]) });

    expect(await templates(rest(fetch), "hmcts", "rdo-docmosis", COMMIT, "Templates")).toEqual([
      { path: "Templates/AAT/Deep/order.docx", sha: sha(17), size: 3 },
      { path: "Templates/Base/claim.docx", sha: sha(15), size: 2 },
      { path: "Templates/top.docx", sha: sha(12), size: 1 }
    ]);
  });

  it("should keep 8 folders in flight when the walk opens out below a single folder", async () => {
    const leaves = Array.from({ length: 24 }, (_, i) => sha(100 + i));
    const trees: Record<string, unknown> = {
      [`${COMMIT}?recursive=1`]: { sha: COMMIT, truncated: true, tree: [] },
      [COMMIT]: { sha: COMMIT, truncated: false, tree: [{ path: "Templates", type: "tree", sha: sha(10) }] },
      [sha(10)]: { sha: sha(10), truncated: false, tree: [{ path: "Only", type: "tree", sha: sha(11) }] },
      [sha(11)]: { sha: sha(11), truncated: false, tree: leaves.map((leaf, i) => ({ path: `F${i}`, type: "tree", sha: leaf })) },
      ...Object.fromEntries(
        leaves.map((leaf, i) => [leaf, { sha: leaf, truncated: false, tree: [{ path: `t${i}.docx`, type: "blob", sha: sha(200 + i), size: 1 }] }])
      )
    };
    let inFlight = 0;
    let most = 0;
    const { fetch } = fakeFetch({
      "/git/trees/": async ({ url }) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return Response.json(trees[url.slice(url.lastIndexOf("/") + 1)]);
      }
    });

    const found = await templates(rest(fetch), "hmcts", "rdo-docmosis", COMMIT, "Templates");

    expect(found).toHaveLength(24);
    expect(most).toBe(8);
  });

  it("should find nothing when the truncated tree has no such folder", async () => {
    const { fetch } = fakeFetch({
      "?recursive=1": () => Response.json({ sha: COMMIT, truncated: true, tree: [] }),
      "/git/trees/": () => Response.json({ sha: COMMIT, truncated: false, tree: [{ path: "Other", type: "tree", sha: sha(1) }] })
    });

    expect(await templates(rest(fetch), "hmcts", "rdo-docmosis", COMMIT, "Templates")).toEqual([]);
  });

  it("should stop the walk at the first folder that fails", async () => {
    const folders = Array.from({ length: 20 }, (_, i) => ({ path: `F${i}`, type: "tree", sha: sha(100 + i) }));
    let asked = 0;
    const { fetch } = fakeFetch({
      "?recursive=1": () => Response.json({ sha: COMMIT, truncated: true, tree: [] }),
      [`/git/trees/${COMMIT}`]: () => Response.json({ sha: COMMIT, truncated: false, tree: [{ path: "Templates", type: "tree", sha: sha(99) }] }),
      [`/git/trees/${sha(99)}`]: () => Response.json({ sha: sha(99), truncated: false, tree: folders }),
      "/git/trees/": ({ url }) => {
        asked += 1;
        return url.endsWith(sha(100))
          ? new Response("{}", { status: 500, statusText: "Server Error" })
          : Response.json({ sha: sha(1), truncated: false, tree: [] });
      }
    });

    const failure = await failureOf(templates(rest(fetch), "hmcts", "rdo-docmosis", COMMIT, "Templates"));

    expect(failure).toEqual({ error: "failed", detail: "GitHub answered 500 Server Error for hmcts/rdo-docmosis." });
    expect(asked).toBeLessThanOrEqual(8);
  });
});

describe("blob", () => {
  it("should read a blob's raw bytes by its SHA-1", async () => {
    const { fetch, calls } = fakeFetch({ "/git/blobs/": () => new Response(new Uint8Array([0x50, 0x4b, 3, 4])) });

    expect(Array.from(await blob(rest(fetch), "hmcts", "rdo-docmosis", sha(1)))).toEqual([0x50, 0x4b, 3, 4]);
    expect(calls[0]?.headers.accept).toBe("application/vnd.github.raw");
    expect((await failureOf(blob(rest(fetch), "hmcts", "rdo-docmosis", "nope"))).error).toBe("failed");
  });
});

describe("githubPage", () => {
  it("should keep a page of exactly 500 characters, and nothing that does not parse", () => {
    const page = `https://github.com/${"x".repeat(500 - 19)}`;

    expect(githubPage(page)).toBe(page);
    expect(githubPage(`${page}x`)).toBeUndefined();
    expect(githubPage("not a url")).toBeUndefined();
    expect(githubPage(undefined)).toBeUndefined();
  });
});

describe("errorFor", () => {
  const NOW = Date.parse("2026-11-18T12:00:00.000Z");
  const answer = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

  it("should read a 401 as signed out", () => {
    expect(errorFor(answer(401), "hmcts/rdo-docmosis").error).toBe("signed_out");
  });

  it("should read SSO, keeping only a github.com page to authorise it", () => {
    expect(errorFor(answer(403, { "x-github-sso": "required; url=https://github.com/orgs/hmcts/sso?authorization_request=abc" }), "hmcts/r")).toMatchObject({
      error: "sso",
      sso_url: "https://github.com/orgs/hmcts/sso?authorization_request=abc"
    });
    expect(errorFor(answer(403, { "x-github-sso": "required; url=https://evil.example/sso" }), "hmcts/r").sso_url).toBeUndefined();
    expect(errorFor(answer(403, { "x-github-sso": "required" }), "hmcts/r")).toMatchObject({ error: "sso" });
  });

  it.each([
    ["an explicit default port", "https://github.com:443/orgs/hmcts/sso?a=1", "https://github.com/orgs/hmcts/sso?a=1"],
    ["a host in capitals", "https://GitHub.com/orgs/hmcts/sso", "https://github.com/orgs/hmcts/sso"],
    ["a query with no path", "https://github.com?authorization_request=1", "https://github.com/?authorization_request=1"]
  ])("should keep an SSO page in the form the hub takes when it has %s", (_label, url, kept) => {
    expect(errorFor(answer(403, { "x-github-sso": `required; url=${url}` }), "hmcts/r")).toMatchObject({ error: "sso", sso_url: kept });
  });

  it.each([
    ["is over 500 characters", `https://github.com/orgs/hmcts/sso?a=${"x".repeat(470)}`],
    ["is not https", "http://github.com/orgs/hmcts/sso"],
    ["names a user", "https://someone@github.com/orgs/hmcts/sso"],
    ["is on another port", "https://github.com:8443/orgs/hmcts/sso"]
  ])("should still say sso, with no link, when the SSO page %s", (_label, url) => {
    const failure = errorFor(answer(403, { "x-github-sso": `required; url=${url}` }), "hmcts/r");

    expect(failure.error).toBe("sso");
    expect(failure).not.toHaveProperty("sso_url");
  });

  it("should read a rate limit, preferring retry-after to the reset header", () => {
    expect(errorFor(answer(429, { "retry-after": "60", "x-ratelimit-reset": "1" }), "hmcts/r", NOW)).toMatchObject({
      error: "rate_limited",
      reset_at: "2026-11-18T12:01:00.000Z"
    });
    expect(errorFor(answer(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 120) }), "hmcts/r", NOW)).toMatchObject({
      error: "rate_limited",
      reset_at: "2026-11-18T12:02:00.000Z"
    });
    expect(errorFor(answer(403, { "retry-after": "0" }), "hmcts/r", NOW)).toEqual({ error: "rate_limited", detail: expect.any(String) });
  });

  it("should read a 404 as not found, and anything else as failed", () => {
    expect(errorFor(answer(404), "hmcts/r").error).toBe("not_found");
    expect(errorFor(answer(403), "hmcts/r").error).toBe("failed");
    expect(errorFor(new Response(null, { status: 502, statusText: "Bad Gateway" }), "hmcts/r").detail).toBe("GitHub answered 502 Bad Gateway for hmcts/r.");
  });
});
