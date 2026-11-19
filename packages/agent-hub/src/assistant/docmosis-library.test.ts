import { describe, expect, it } from "vitest";
import type { DocmosisIndexAnswer } from "../wire.ts";
import {
  createDocmosisIndexRunner,
  type DocmosisIndexDeps,
  type DocmosisIndexFrame,
  INDEX_TOTAL_MS,
  indexEntries,
  MAX_INDEX_BYTES,
  MAX_INDEX_ENTRIES,
  parseIndexFrame,
  runIndex
} from "./docmosis-library.ts";
import type { FetchLike } from "./github-rest.ts";

const TOKEN = "gho_supersecrettokenvalue123";
const HELD = "a".repeat(40);
const MOVED = "c".repeat(40);
const BLOB = "b".repeat(40);
const REQUEST_ID = "5b0e7c1a-1111-4222-8333-444455556666";

const FRAME: DocmosisIndexFrame = {
  request_id: REQUEST_ID,
  owner: "hmcts",
  repo: "rdo-docmosis",
  ref: "HEAD",
  path: "Templates",
  commit: HELD,
  etag: '"e1"'
};

const signedIn = async () => ({ code: 0, stdout: `${TOKEN}\n`, stderr: "" });

function deps(fetch: FetchLike, overrides: Partial<DocmosisIndexDeps> = {}): DocmosisIndexDeps & { said: string[]; answers: unknown[] } {
  const said: string[] = [];
  const answers: unknown[] = [];
  return {
    api: {
      putDocmosisIndex: async (_id, requestId, body) => {
        answers.push({ requestId, body });
        return null;
      }
    },
    id: "va-1",
    run: signedIn,
    env: {},
    fetch,
    say: (message) => said.push(message),
    said,
    answers,
    ...overrides
  };
}

const tree = (entries: { path: string; size?: number }[], truncated = false) =>
  Response.json({ sha: MOVED, truncated, tree: entries.map((entry) => ({ type: "blob", sha: BLOB, size: 1, ...entry })) });

/** A GitHub whose commit check answers `commit` and whose tree is `entries`, recording the URLs asked. */
function github(commit: Response | (() => Response), treeResponse: () => Response = () => tree([])) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    asked.push({ url, headers: init.headers });
    if (url.includes("/commits/")) {
      return typeof commit === "function" ? commit() : commit;
    }
    return treeResponse();
  };
  return { fetch, asked };
}

describe("parseIndexFrame", () => {
  it("should take a frame of the contract's shape", () => {
    expect(parseIndexFrame(FRAME)).toEqual(FRAME);
    expect(parseIndexFrame({ ...FRAME, commit: null, etag: null })).toEqual({ ...FRAME, commit: null, etag: null });
  });

  it.each([
    ["no request id", { request_id: "x" }],
    ["an owner that is not a login", { owner: "-hmcts" }],
    ["a repository that climbs", { repo: ".." }],
    ["a ref that climbs", { ref: "a/../b" }],
    ["a path that climbs", { path: "Templates/../x" }],
    ["an absolute path", { path: "/Templates" }],
    ["a commit that is not a SHA-1", { commit: "HEAD" }],
    ["an ETag that is not one", { etag: "e1" }],
    ["no commit at all", { commit: undefined }]
  ])("should refuse a frame with %s", (_label, change) => {
    expect(parseIndexFrame({ ...FRAME, ...change })).toBeNull();
  });

  it("should refuse a frame that is not an object", () => {
    expect(parseIndexFrame(null)).toBeNull();
    expect(parseIndexFrame([FRAME])).toBeNull();
  });
});

describe("indexEntries", () => {
  it("should keep the templates as tuples, in the order given", () => {
    const found = [
      { path: "Templates/b.docx", sha: BLOB, size: 3 },
      { path: "Templates/a.docx", sha: BLOB, size: 1 }
    ];

    expect(indexEntries(found)).toEqual({
      entries: [
        ["Templates/b.docx", BLOB, 3],
        ["Templates/a.docx", BLOB, 1]
      ],
      dropped: 0
    });
  });

  it("should stop at the hub's count", () => {
    const found = Array.from({ length: MAX_INDEX_ENTRIES + 5 }, (_, i) => ({ path: `Templates/${i}.docx`, sha: BLOB, size: 1 }));

    const { entries, dropped } = indexEntries(found);

    expect(entries).toHaveLength(MAX_INDEX_ENTRIES);
    expect(dropped).toBe(5);
  });

  it("should stop within the hub's 1 MiB, as it measures the stored entries", () => {
    const found = Array.from({ length: 5000 }, (_, i) => ({ path: `Templates/${"y".repeat(300)}-${i}.docx`, sha: BLOB, size: 123456 }));

    const { entries, dropped } = indexEntries(found);
    const stored = Buffer.byteLength(JSON.stringify(entries)) + 3 * entries.length;
    const body = Buffer.byteLength(JSON.stringify({ commit: MOVED, etag: `"${"e".repeat(198)}"`, entries }));

    expect(dropped).toBeGreaterThan(0);
    expect(stored).toBeLessThanOrEqual(MAX_INDEX_BYTES);
    expect(body).toBeLessThanOrEqual(MAX_INDEX_BYTES);
  });
});

describe("runIndex", () => {
  it("should answer unchanged on a 304, having sent the ETag the hub holds", async () => {
    const { fetch, asked } = github(new Response(null, { status: 304, headers: { etag: '"e1"' } }));

    expect(await runIndex(deps(fetch), FRAME)).toEqual({ unchanged: true, etag: '"e1"' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.headers["if-none-match"]).toBe('"e1"');
  });

  it("should answer unchanged without reading the tree when the commit is the one the hub holds", async () => {
    const { fetch, asked } = github(new Response(HELD, { headers: { etag: '"e2"' } }));

    expect(await runIndex(deps(fetch), FRAME)).toEqual({ unchanged: true, etag: '"e2"' });
    expect(asked).toHaveLength(1);
  });

  it("should send no ETag when the hub holds no index, and answer the whole index", async () => {
    const { fetch, asked } = github(new Response(MOVED, { headers: { etag: '"e3"' } }), () =>
      tree([{ path: "Templates/b.docx", size: 2 }, { path: "Templates/a.docx", size: 1 }, { path: "Templates/~$a.docx" }])
    );

    const answer = await runIndex(deps(fetch), { ...FRAME, commit: null, etag: '"stale"' });

    expect(answer).toEqual({
      commit: MOVED,
      etag: '"e3"',
      entries: [
        ["Templates/a.docx", BLOB, 1],
        ["Templates/b.docx", BLOB, 2]
      ],
      dropped: 0
    });
    expect(asked[0]?.headers["if-none-match"]).toBeUndefined();
  });

  it("should never answer a path the hub would refuse, when the tree holds one", async () => {
    const { fetch } = github(new Response(MOVED), () => tree([{ path: "Templates/a.docx" }, { path: `Templates/${"x".repeat(400)}.docx` }]));

    expect(await runIndex(deps(fetch), FRAME)).toEqual({ commit: MOVED, etag: null, entries: [["Templates/a.docx", BLOB, 1]], dropped: 0 });
  });

  it("should give the token read only what is left of the total, when the frame arrived a minute ago", async () => {
    const now = 1_000_000;
    const timeouts: number[] = [];
    const d = deps(github(new Response(null, { status: 304 })).fetch, {
      clock: () => now,
      run: async (_cmd, _args, opts) => {
        timeouts.push(opts.timeoutMs);
        return signedIn();
      }
    });

    await runIndex(d, FRAME, now - 60_000);

    expect(timeouts).toEqual([INDEX_TOTAL_MS - 60_000 - 21_000]);
  });

  it("should answer failed without asking GitHub, when the token read used up GitHub's share of the total", async () => {
    let now = 1_000_000;
    const { fetch, asked } = github(new Response(MOVED));
    const d = deps(fetch, {
      clock: () => now,
      run: async () => {
        now += INDEX_TOTAL_MS - 21_000;
        return signedIn();
      }
    });

    expect(await runIndex(d, FRAME, now)).toMatchObject({ error: "failed" });
    expect(asked).toEqual([]);
  });

  it("should answer failed without reading the token, when the frame arrived too long ago", async () => {
    const now = 1_000_000;
    let reads = 0;
    const d = deps(github(new Response(MOVED)).fetch, {
      clock: () => now,
      run: async () => {
        reads += 1;
        return signedIn();
      }
    });

    expect(await runIndex(d, FRAME, now - INDEX_TOTAL_MS)).toMatchObject({ error: "failed" });
    expect(reads).toBe(0);
  });

  it("should send a null ETag rather than one the hub would refuse", async () => {
    const { fetch } = github(new Response(MOVED, { headers: { etag: "unquoted" } }));

    expect(await runIndex(deps(fetch), FRAME)).toEqual({ commit: MOVED, etag: null, entries: [], dropped: 0 });
  });

  it.each<[string, Response, Partial<DocmosisIndexAnswer>]>([
    ["a 401", new Response(null, { status: 401 }), { error: "signed_out" }],
    [
      "SSO",
      new Response(null, { status: 403, headers: { "x-github-sso": "required; url=https://github.com/orgs/hmcts/sso?authorization_request=1" } }),
      { error: "sso", sso_url: "https://github.com/orgs/hmcts/sso?authorization_request=1" }
    ],
    ["a 404", new Response(null, { status: 404 }), { error: "not_found" }],
    ["a 429", new Response(null, { status: 429, headers: { "retry-after": "30" } }), { error: "rate_limited" }]
  ])("should answer %s as the hub's reason", async (_label, response, expected) => {
    const answer = await runIndex(deps(github(response).fetch), FRAME);

    expect(answer).toMatchObject(expected);
    expect(String((answer as { detail?: string }).detail).length).toBeLessThanOrEqual(300);
  });

  it("should give a rate limit's reset time", async () => {
    const answer = await runIndex(deps(github(new Response(null, { status: 429, headers: { "retry-after": "30" } })).fetch), FRAME);

    expect((answer as { reset_at?: string }).reset_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("should answer signed out without asking GitHub when gh has no token", async () => {
    const { fetch, asked } = github(new Response(MOVED));

    expect(await runIndex(deps(fetch, { run: async () => ({ code: 1, stdout: "", stderr: "not logged in" }) }), FRAME)).toMatchObject({ error: "signed_out" });
    expect(asked).toEqual([]);
  });

  it("should answer failed when something unexpected throws", async () => {
    const fetch: FetchLike = async (url) => {
      if (url.includes("/commits/")) {
        return new Response(MOVED);
      }
      return new Response("not json");
    };

    expect(await runIndex(deps(fetch), FRAME)).toMatchObject({ error: "failed" });
  });

  it("should never put the token in an answer or in what it says", async () => {
    const said: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      throw new Error(`refused the header ${init.headers.authorization}`);
    };
    const runner = createDocmosisIndexRunner({ ...deps(fetch), say: (message) => said.push(message) });
    const answers: unknown[] = [];
    const recording = createDocmosisIndexRunner({
      ...deps(fetch, {
        api: {
          putDocmosisIndex: async (_id, _requestId, body) => {
            answers.push(body);
            throw new Error("hub down");
          }
        }
      }),
      say: (message) => said.push(message)
    });

    runner.docmosisIndex(FRAME);
    recording.docmosisIndex(FRAME);
    await runner.idle();
    await recording.idle();

    expect(answers.length).toBeGreaterThan(0);
    expect(JSON.stringify(answers)).toContain("[redacted]");
    expect(JSON.stringify(answers)).not.toContain(TOKEN);
    expect(said.join("\n")).not.toContain(TOKEN);
  });
});

describe("runIndex redaction", () => {
  it("should redact a credential that is not the token, when what fetch threw says one", async () => {
    const other = `${"gh"}p_${"Z9y8X7w6".repeat(4)}`;
    const fetch: FetchLike = async () => {
      throw new Error(`refused ${other}`);
    };

    const answer = await runIndex(deps(fetch), FRAME);

    expect(answer).toMatchObject({ error: "failed" });
    expect(JSON.stringify(answer)).not.toContain(other);
    expect(JSON.stringify(answer)).toContain("[redacted]");
  });
});

describe("createDocmosisIndexRunner", () => {
  it("should answer a check through the hub's route", async () => {
    const d = deps(github(new Response(null, { status: 304 })).fetch);
    const runner = createDocmosisIndexRunner(d);

    runner.docmosisIndex(FRAME);
    await runner.idle();

    expect(d.answers).toEqual([{ requestId: REQUEST_ID, body: { unchanged: true } }]);
  });

  it("should run one check at a time, a newer frame replacing one still waiting", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let commits = 0;
    const fetch: FetchLike = async () => {
      commits += 1;
      if (commits === 1) {
        await held;
      }
      return new Response(null, { status: 304 });
    };
    const d = deps(fetch);
    const runner = createDocmosisIndexRunner(d);
    const second = "5b0e7c1a-1111-4222-8333-000000000002";
    const third = "5b0e7c1a-1111-4222-8333-000000000003";

    runner.docmosisIndex(FRAME);
    runner.docmosisIndex({ ...FRAME, request_id: second });
    runner.docmosisIndex({ ...FRAME, request_id: third });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(commits).toBe(1);
    release();
    await runner.idle();

    expect(d.answers.map((answer) => (answer as { requestId: string }).requestId)).toEqual([REQUEST_ID, third]);
  });

  it("should ignore a frame that is not a check, and say so", async () => {
    const d = deps(github(new Response(null, { status: 304 })).fetch);
    const runner = createDocmosisIndexRunner(d);

    runner.docmosisIndex({ request_id: "nope" });
    await runner.idle();

    expect(d.answers).toEqual([]);
    expect(d.said[0]).toContain("ignoring a docmosis index check");
  });

  it("should give each attempt at the answer only what is left of the total, and make none once it is spent", async () => {
    let now = 1_000_000;
    const timeouts: (number | undefined)[] = [];
    const d = deps(github(new Response(null, { status: 304 })).fetch, {
      clock: () => now,
      run: async () => {
        now += 64_000;
        return signedIn();
      },
      api: {
        putDocmosisIndex: async (_id, _requestId, _body, options) => {
          timeouts.push(options?.timeoutMs);
          now += 30_000;
          throw new Error("hub slow");
        }
      }
    });
    const runner = createDocmosisIndexRunner(d);

    runner.docmosisIndex(FRAME);
    await runner.idle();

    expect(timeouts).toEqual([10_000]);
    expect(d.said.join("\n")).toContain("too late for the hub to keep the answer");
  });

  it("should give the answer the rest of the total, when GitHub answered near the end of its share", async () => {
    let now = 1_000_000;
    const timeouts: (number | undefined)[] = [];
    const fetch: FetchLike = async () => {
      now += INDEX_TOTAL_MS - 5_000;
      return new Response(null, { status: 304 });
    };
    const d = deps(fetch, {
      clock: () => now,
      api: {
        putDocmosisIndex: async (_id, _requestId, _body, options) => {
          timeouts.push(options?.timeoutMs);
          return null;
        }
      }
    });
    const runner = createDocmosisIndexRunner(d);

    runner.docmosisIndex(FRAME);
    await runner.idle();

    expect(timeouts).toEqual([5_000]);
  });

  it("should say it could not answer when the hub refuses twice", async () => {
    let tries = 0;
    const d = deps(github(new Response(null, { status: 304 })).fetch, {
      api: {
        putDocmosisIndex: async () => {
          tries += 1;
          throw new Error("hub down");
        }
      }
    });
    const runner = createDocmosisIndexRunner(d);

    runner.docmosisIndex(FRAME);
    await runner.idle();

    expect(tries).toBe(2);
    expect(d.said.join("\n")).toContain("could not answer it: hub down");
  });
});
