import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.ts";
import type { DocmosisBody } from "../wire.ts";
import {
  blobCacheDir,
  clip,
  type DocmosisLoadDeps,
  docmosisCommand,
  docmosisLoadHandler,
  GITHUB_TIMEOUT_MS,
  gitBlobSha1,
  MAX_TEMPLATE_BYTES,
  PUBLISH_RESERVE_MS,
  parseLoadArgs,
  pruneCache,
  SCHEMA_TIMEOUT_MS,
  TOKEN_TIMEOUT_MS
} from "./docmosis-load.ts";
import { DOCMOSIS_LOAD_KIND, LOAD_BUDGET_MS } from "./docmosis-load-kind.ts";
import type { FetchLike } from "./github-rest.ts";
import type { Run } from "./lookups.ts";
import { POD_JOB_HANDLERS } from "./pod-job-handlers.ts";
import { type PodJobContext, PodJobError, type PodJobHandler, type PodJobHandlerApi } from "./pod-jobs.ts";

const TOKEN = "gho_supersecrettokenvalue123";
const JOB = "0b9d6c1e-3c1f-4a5e-9f43-8d2a7c6b5e41";
const AGENT = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const PATH = "Templates/Base/Claim form.docx";
const LIBRARY = { owner: "hmcts", repo: "rdo-docmosis", folder: "Templates" };
const SCHEMA = { root: { kind: "object", controls: [], notes: [], properties: {} }, warnings: [] };

function docx(seed: number, length = 64): Uint8Array {
  const bytes = Buffer.alloc(length);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  bytes.writeUInt32BE(seed, 8);
  return new Uint8Array(bytes);
}

const TEMPLATE = docx(1);
const BLOB = gitBlobSha1(TEMPLATE);
const ITEM = "5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b";
const CREATED = "6c6c6c6c-6c6c-46c6-86c6-6c6c6c6c6c6c";
/** A load into a template the conversation holds. */
const ARGS = { ...LIBRARY, item: ITEM, path: PATH, blob_sha: BLOB, base_version: 2, base_revision: 1 };
/** A load that makes a new template. */
const NEW_ARGS = { ...LIBRARY, path: PATH, blob_sha: BLOB, base_version: 0, base_revision: 0 };

const { sha1Hashes } = vi.hoisted(() => ({ sha1Hashes: { count: 0 } }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: (algorithm: string, ...rest: unknown[]) => {
      if (algorithm === "sha1") {
        sha1Hashes.count += 1;
      }
      return actual.createHash(algorithm, ...(rest as []));
    }
  };
});

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "docmosis-load-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A pod whose `gh` is signed in and whose `docmosis schema` prints `SCHEMA`, recording every command it ran. */
function runner(overrides: { token?: string | null; schema?: { code: number; stdout: string; stderr: string }; onSchema?: () => void } = {}) {
  const ran: { cmd: string; args: string[]; path: string | undefined }[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const timeouts: number[] = [];
  const run: Run = async (cmd, args, opts) => {
    ran.push({ cmd, args, path: opts.env.PATH });
    signals.push(opts.signal);
    timeouts.push(opts.timeoutMs);
    if (cmd === "gh") {
      const token = overrides.token === undefined ? TOKEN : overrides.token;
      return token === null ? { code: 1, stdout: "", stderr: "not logged in" } : { code: 0, stdout: `${token}\n`, stderr: "" };
    }
    overrides.onSchema?.();
    return overrides.schema ?? { code: 0, stdout: JSON.stringify(SCHEMA), stderr: "" };
  };
  return { run, ran, signals, timeouts };
}

/** A GitHub whose blob route answers `respond`, recording the URLs asked and the headers sent. */
function github(respond: () => Response = () => new Response(Buffer.from(TEMPLATE))) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    asked.push({ url, headers: init.headers });
    return respond();
  };
  return { fetch, asked };
}

/** The agent API, recording what was published; `conflict` makes the version write a 409. */
function hub({
  conflict = false,
  refuse,
  loaded
}: {
  conflict?: boolean;
  refuse?: number;
  loaded?: { item?: string; version: number; revision: number };
} = {}) {
  const assets: { sha256: string; bytes: Uint8Array }[] = [];
  const puts: DocmosisBody[] = [];
  const writtenTo: (string | undefined)[] = [];
  const creates: DocmosisBody[] = [];
  const unused = async (): Promise<never> => Promise.reject(new Error("not here"));
  const api: PodJobHandlerApi = {
    getArtefact: unused,
    putArtefact: unused,
    getDocmosis: unused,
    listNotify: unused,
    getNotifyById: unused,
    putNotifyById: unused,
    createNotify: unused,
    getVideo: unused,
    videoPosted: unused,
    putDocmosisAsset: async (_agent, sha256, bytes) => {
      assets.push({ sha256, bytes });
      return { asset: `sha256:${sha256}` };
    },
    createDocmosis: async (_agent, body) => {
      creates.push(body);
      if (loaded !== undefined) {
        throw new ApiError(409, { error: "that template has already been loaded", loaded }, "POST", "/docmosis-templates");
      }
      return { id: CREATED, version: 1, revision: 0 };
    },
    putDocmosis: async (_agent, body, id) => {
      puts.push(body);
      writtenTo.push(id);
      if (refuse !== undefined) {
        throw new ApiError(refuse, { error: `refused with ${TOKEN}` }, "PUT", "/docmosis");
      }
      if (loaded !== undefined) {
        throw new ApiError(409, { error: "that template has already been loaded", loaded }, "PUT", "/docmosis");
      }
      if (conflict) {
        throw new ApiError(409, { error: "changed" }, "PUT", "/docmosis");
      }
      return { version: 3, revision: 0 };
    },
    docmosisAsset: unused,
    putDocmosisPdf: unused,
    postQuestion: unused
  };
  return { api, assets, puts, writtenTo, creates };
}

function context(api: PodJobHandlerApi, overrides: Partial<PodJobContext> = {}): PodJobContext {
  return {
    jobId: JOB,
    conversationId: "c0ffee00-0000-4000-8000-000000000000",
    agentId: AGENT,
    signal: new AbortController().signal,
    api,
    env: { HOME: home, PATH: "/usr/bin" },
    say: () => undefined,
    ...overrides
  };
}

async function failureOf(work: Promise<unknown>): Promise<PodJobError> {
  const thrown = await work.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(thrown).toBeInstanceOf(PodJobError);
  return thrown as PodJobError;
}

const cacheFile = (sha = BLOB) => path.join(blobCacheDir({ HOME: home }), `${sha}.docx`);

function load(deps: Partial<DocmosisLoadDeps> & { run: Run }, api: PodJobHandlerApi, args: unknown = ARGS, overrides: Partial<PodJobContext> = {}) {
  return docmosisLoadHandler({ execPath: "/nvm/versions/node/v24/bin/node", ...deps }).run(args, context(api, overrides));
}

describe("docmosisLoadHandler", () => {
  it("should fetch the blob, read its schema and publish it as the pick when the cache does not hold it", async () => {
    // Arrange
    const { run, ran } = runner();
    const { fetch, asked } = github();
    const { api, assets, puts } = hub();

    // Act
    const result = await load({ run, fetch }, api);

    // Assert
    expect(result).toEqual({ item: ITEM, version: 3, revision: 0 });
    expect(asked.map((call) => call.url)).toEqual([`https://api.github.com/repos/hmcts/rdo-docmosis/git/blobs/${BLOB}`]);
    expect(asked[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fs.readFileSync(cacheFile())).toEqual(Buffer.from(TEMPLATE));
    expect(ran.at(-1)).toEqual({ cmd: "docmosis", args: ["schema", cacheFile()], path: "/nvm/versions/node/v24/bin:/usr/bin" });
    expect(assets).toEqual([{ sha256: createHash("sha256").update(TEMPLATE).digest("hex"), bytes: TEMPLATE }]);
    expect(puts).toEqual([
      {
        name: "Claim form.docx",
        docx: `sha256:${createHash("sha256").update(TEMPLATE).digest("hex")}`,
        schema: SCHEMA,
        data: {},
        base_version: 2,
        base_revision: 1,
        summary: "Loaded Claim form.docx",
        pick: JOB
      }
    ]);
  });

  it("should use the cached blob and ask GitHub nothing when the cache holds it", async () => {
    // Arrange
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), TEMPLATE);
    const { run } = runner();
    const { fetch, asked } = github();
    const { api, puts } = hub();

    // Act
    await load({ run, fetch }, api);

    // Assert
    expect(asked).toEqual([]);
    expect(puts).toHaveLength(1);
  });

  it("should fetch the blob again when the cached file no longer hashes to it", async () => {
    // Arrange
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), docx(2));
    const { run } = runner();
    const { fetch, asked } = github();
    const { api } = hub();

    // Act
    await load({ run, fetch }, api);

    // Assert
    expect(asked).toHaveLength(1);
    expect(fs.readFileSync(cacheFile())).toEqual(Buffer.from(TEMPLATE));
  });

  it("should answer checksum and cache nothing when GitHub sends other bytes than the blob", async () => {
    const { run } = runner();
    const { fetch } = github(() => new Response(Buffer.from(docx(2))));
    const { api, puts } = hub();

    const failure = await failureOf(load({ run, fetch }, api));

    expect(failure.code).toBe("checksum");
    expect(fs.existsSync(cacheFile())).toBe(false);
    expect(puts).toEqual([]);
  });

  it("should answer too_large when the blob is over 5 MiB", async () => {
    const big = docx(3, MAX_TEMPLATE_BYTES + 1);
    const { run } = runner();
    const { fetch } = github(() => new Response(Buffer.from(big)));
    const { api } = hub();

    const failure = await failureOf(load({ run, fetch }, api, { ...ARGS, blob_sha: gitBlobSha1(big) }));

    expect(failure.code).toBe("too_large");
  });

  it("should answer too_large and cache nothing when GitHub's content-length is over 5 MiB", async () => {
    const { run } = runner();
    const { fetch } = github(() => new Response(Buffer.from(TEMPLATE), { headers: { "content-length": String(MAX_TEMPLATE_BYTES + 1) } }));
    const { api, puts } = hub();

    const failure = await failureOf(load({ run, fetch }, api));

    expect(failure.code).toBe("too_large");
    expect(fs.existsSync(cacheFile())).toBe(false);
    expect(puts).toEqual([]);
  });

  it("should read the blob from the library the hub named when the job's arguments carry one", async () => {
    const { run } = runner();
    const { fetch, asked } = github();
    const { api } = hub();

    await load({ run, fetch }, api, { ...ARGS, owner: "hmcts-other", repo: "letters", folder: "Templates/Base" });

    expect(asked.map((call) => call.url)).toEqual([`https://api.github.com/repos/hmcts-other/letters/git/blobs/${BLOB}`]);
  });

  it("should hash a cached blob once when the cache holds it", async () => {
    // Arrange
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), TEMPLATE);
    const { run } = runner();
    const { api } = hub();
    sha1Hashes.count = 0;

    // Act
    await load({ run, fetch: github().fetch }, api);

    // Assert
    expect(sha1Hashes.count).toBe(1);
  });

  it("should answer not_docx when the blob is not a zip", async () => {
    const text = new TextEncoder().encode("not a template");
    const { run } = runner();
    const { fetch } = github(() => new Response(Buffer.from(text)));
    const { api } = hub();

    const failure = await failureOf(load({ run, fetch }, api, { ...ARGS, blob_sha: gitBlobSha1(text) }));

    expect(failure.code).toBe("not_docx");
  });

  it("should answer schema_failed with the CLI's words when docmosis schema fails", async () => {
    const { run } = runner({ schema: { code: 1, stdout: "", stderr: "unbalanced block at paragraph 3" } });
    const { fetch } = github();
    const { api, puts } = hub();

    const failure = await failureOf(load({ run, fetch }, api));

    expect(failure.code).toBe("schema_failed");
    expect(failure.detail).toContain("unbalanced block at paragraph 3");
    expect(puts).toEqual([]);
  });

  it.each([
    ["it prints something that is not JSON", "{oops"],
    ["it prints a schema with no object root", JSON.stringify({ root: { kind: "string" }, warnings: [] })]
  ])("should answer schema_failed when %s", async (_label, stdout) => {
    const { run } = runner({ schema: { code: 0, stdout, stderr: "" } });
    const { fetch } = github();
    const { api } = hub();

    expect((await failureOf(load({ run, fetch }, api))).code).toBe("schema_failed");
  });

  it("should answer conflict when the template changed since the base", async () => {
    const { run } = runner();
    const { fetch } = github();
    const { api } = hub({ conflict: true });

    expect((await failureOf(load({ run, fetch }, api))).code).toBe("conflict");
  });

  it("should answer with the version an earlier run wrote when the hub says the pick is already loaded", async () => {
    const { run } = runner();
    const { fetch } = github();
    const { api, puts } = hub({ loaded: { item: ITEM, version: 3, revision: 0 } });

    const result = await load({ run, fetch }, api);

    expect(result).toEqual({ item: ITEM, version: 3, revision: 0 });
    expect(puts).toHaveLength(1);
  });

  it("should write the template the job names, and make no new one, when the args carry an item", async () => {
    const { run } = runner();
    const { fetch } = github();
    const { api, writtenTo, creates } = hub();

    await load({ run, fetch }, api);

    expect(writtenTo).toEqual([ITEM]);
    expect(creates).toEqual([]);
  });

  it("should make a new template and answer its id when the args carry no item", async () => {
    const { run } = runner();
    const { fetch } = github();
    const { api, puts, creates } = hub();

    const result = await load({ run, fetch }, api, NEW_ARGS);

    expect(result).toEqual({ item: CREATED, version: 1, revision: 0 });
    expect(puts).toEqual([]);
    expect(creates).toEqual([expect.objectContaining({ base_version: 0, pick: JOB, summary: "Loaded Claim form.docx" })]);
  });

  it("should answer with the template an earlier run made when the hub says a new template's pick is already loaded", async () => {
    const { run } = runner();
    const { fetch } = github();
    const { api } = hub({ loaded: { item: CREATED, version: 1, revision: 0 } });

    expect(await load({ run, fetch }, api, NEW_ARGS)).toEqual({ item: CREATED, version: 1, revision: 0 });
  });

  it("should answer signed_out and ask GitHub nothing when the pod's gh has no token", async () => {
    const { run } = runner({ token: null });
    const { fetch, asked } = github();
    const { api } = hub();

    expect((await failureOf(load({ run, fetch }, api))).code).toBe("signed_out");
    expect(asked).toEqual([]);
  });

  it.each([
    [401, {}, "signed_out"],
    [403, { "x-github-sso": "required; url=https://github.com/orgs/hmcts/sso?authorization_request=1" }, "sso"],
    [404, {}, "not_found"],
    [429, { "retry-after": "30" }, "rate_limited"]
  ])("should answer with GitHub's code when GitHub answers %i", async (status, headers, code) => {
    const { run } = runner();
    const { fetch } = github(() => new Response("{}", { status, headers }));
    const { api } = hub();

    expect((await failureOf(load({ run, fetch }, api))).code).toBe(code);
  });

  it("should never say the token when a failure would carry it", async () => {
    // Arrange
    const { run } = runner();
    const { api } = hub({ refuse: 400 });
    const loud: FetchLike = async () => {
      throw new Error(`socket hang up sending Bearer ${TOKEN}`);
    };

    // Act
    const network = await failureOf(load({ run, fetch: loud }, api));
    const refused = await failureOf(load({ run, fetch: github().fetch }, api));

    // Assert
    expect(network.code).toBe("failed");
    expect(refused.code).toBe("failed");
    for (const failure of [network, refused]) {
      expect(JSON.stringify([failure.message, failure.detail])).not.toContain(TOKEN);
    }
  });

  it("should answer failed with the hub's reason when the hub has no conversation for the agent", async () => {
    const { run } = runner();
    const { api } = hub();
    const gone: PodJobHandlerApi = {
      ...api,
      putDocmosisAsset: async () => {
        throw new ApiError(404, { error: "no such agent" }, "PUT", "/docmosis/assets");
      }
    };

    const failure = await failureOf(load({ run, fetch: github().fetch }, gone));

    expect(failure).toMatchObject({ code: "failed", detail: "This chat is not on the hub any more." });
  });

  it("should answer failed with what went wrong when something unforeseen fails", async () => {
    const { run } = runner();
    const { api } = hub();
    const broken: PodJobHandlerApi = {
      ...api,
      putDocmosis: async () => {
        throw new Error("the disk is full");
      }
    };

    const failure = await failureOf(load({ run, fetch: github().fetch }, broken));

    expect(failure.code).toBe("failed");
    expect(failure.detail).toContain("the disk is full");
  });

  it("should leave no partial file behind when the cache cannot be written", async () => {
    const { run } = runner();
    const { api, puts } = hub();
    const failing = { ...fs.promises, rename: async () => Promise.reject(new Error("read-only file system")) };

    const failure = await failureOf(load({ run, fetch: github().fetch, fs: failing }, api));

    expect(failure.code).toBe("failed");
    expect(fs.readdirSync(path.dirname(cacheFile()))).toEqual([]);
    expect(puts).toEqual([]);
  });

  it("should refuse and ask nothing when the arguments are not a library pick", async () => {
    const { run, ran } = runner();
    const { api } = hub();

    const failure = await failureOf(load({ run }, api, { ...ARGS, path: "../etc/passwd.docx" }));

    expect(failure.code).toBe("failed");
    expect(ran).toEqual([]);
  });

  it("should fail when the conversation has no session agent to publish through", async () => {
    const { run } = runner();
    const { api } = hub();

    expect((await failureOf(load({ run }, api, ARGS, { agentId: undefined }))).code).toBe("failed");
  });

  it("should pass the job's signal to every command it runs when it runs gh and docmosis", async () => {
    const { run, signals, timeouts } = runner();
    const controller = new AbortController();

    await load({ run, fetch: github().fetch }, hub().api, ARGS, { signal: controller.signal });

    expect(signals).toEqual([controller.signal, controller.signal]);
    expect(timeouts).toEqual([TOKEN_TIMEOUT_MS, SCHEMA_TIMEOUT_MS]);
  });

  it("should publish nothing when the budget runs out while docmosis schema runs", async () => {
    // Arrange
    const controller = new AbortController();
    const { run } = runner({ onSchema: () => controller.abort(), schema: { code: 1, stdout: "", stderr: "killed" } });
    const { api, assets, puts } = hub();

    // Act
    const failure = await failureOf(load({ run, fetch: github().fetch }, api, ARGS, { signal: controller.signal }));

    // Assert
    expect(failure.code).toBe("failed");
    expect(assets).toEqual([]);
    expect(puts).toEqual([]);
  });

  it("should publish nothing when the budget runs out after docmosis schema succeeds", async () => {
    const controller = new AbortController();
    const { run } = runner({ onSchema: () => controller.abort() });
    const { api, assets, puts } = hub();

    await failureOf(load({ run, fetch: github().fetch }, api, ARGS, { signal: controller.signal }));

    expect(assets).toEqual([]);
    expect(puts).toEqual([]);
  });

  it("should write no version when the budget runs out while the .docx uploads", async () => {
    // Arrange
    const controller = new AbortController();
    const { run } = runner();
    const { api, puts } = hub();
    const slow: PodJobHandlerApi = {
      ...api,
      putDocmosisAsset: async (agent, sha256, bytes) => {
        const uploaded = await api.putDocmosisAsset(agent, sha256, bytes);
        controller.abort();
        return uploaded;
      }
    };

    // Act
    await failureOf(load({ run, fetch: github().fetch }, slow, ARGS, { signal: controller.signal }));

    // Assert
    expect(puts).toEqual([]);
  });

  it("should ask GitHub nothing when the budget has run out by the time the token is read", async () => {
    const { run } = runner();
    const { fetch, asked } = github();

    await failureOf(load({ run, fetch }, hub().api, ARGS, { signal: AbortSignal.abort() }));

    expect(asked).toEqual([]);
  });

  it("should redact other credential-shaped words when a failure carries them", async () => {
    // Arrange
    const other = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    const { run } = runner({ schema: { code: 1, stdout: "", stderr: `token ${other} refused` } });

    // Act
    const failure = await failureOf(load({ run, fetch: github().fetch }, hub().api));

    // Assert
    expect(failure.code).toBe("schema_failed");
    expect(failure.detail).not.toContain(other);
    expect(failure.detail).toContain("[redacted]");
  });

  it("should leave a margin inside the budget when every step runs to its cap", () => {
    expect(TOKEN_TIMEOUT_MS + GITHUB_TIMEOUT_MS + SCHEMA_TIMEOUT_MS + PUBLISH_RESERVE_MS).toBeLessThan(LOAD_BUDGET_MS);
  });

  it("should fit the registered handler's budget inside the hub's two minutes when POD_JOB_HANDLERS lists it", () => {
    const registered = POD_JOB_HANDLERS.find((handler) => handler.kind === "docmosis.load");

    expect(registered?.budgetMs).toBe(LOAD_BUDGET_MS);
    expect(LOAD_BUDGET_MS).toBeLessThan(120_000);
    expect(registered?.kind).toBe(DOCMOSIS_LOAD_KIND);
    expect(docmosisLoadHandler({ run: runner().run }).kind).toBe(DOCMOSIS_LOAD_KIND);
  });

  it("should load the handler's module when the registered handler runs a job", async () => {
    const registered = POD_JOB_HANDLERS.find((handler) => handler.kind === "docmosis.load") as PodJobHandler;

    const failure = await failureOf(registered.run({ path: "not a pick" }, context(hub().api)));

    expect(failure.code).toBe("failed");
  });
});

describe("parseLoadArgs", () => {
  it("should take a pick when it is one the hub's schema took, with the library the hub added", () => {
    expect(parseLoadArgs(ARGS)).toEqual(ARGS);
  });

  it("should take a pick that names no item, which makes a new template", () => {
    expect(parseLoadArgs(NEW_ARGS)).toEqual(NEW_ARGS);
  });

  it.each([
    ["no object at all", "x"],
    ["an extra field", { ...ARGS, name: "x" }],
    ["a path outside the library", { ...ARGS, path: "Other/x.docx" }],
    ["a path outside the folder the hub named", { ...ARGS, folder: "Letters" }],
    ["no library", { path: PATH, blob_sha: BLOB, base_version: 2, base_revision: 1 }],
    ["an owner that is not a GitHub login", { ...ARGS, owner: "hm cts" }],
    ["a repository name that is not one", { ...ARGS, repo: ".." }],
    ["a folder that climbs", { ...ARGS, folder: "Templates/..", path: "Templates/../x.docx" }],
    ["a folder that is not a string", { ...ARGS, folder: 1 }],
    ["a blob that is not a SHA-1", { ...ARGS, blob_sha: "x" }],
    ["an item that is not an id", { ...ARGS, item: "nope" }],
    ["a base that is not a whole number", { ...ARGS, base_version: 1.5 }],
    ["a negative revision", { ...ARGS, base_revision: -1 }]
  ])("should refuse the arguments when they have %s", (_label, value) => {
    expect(parseLoadArgs(value)).toBeNull();
  });
});

describe("clip", () => {
  it("should keep the text whole when it fits", () => {
    expect(clip("abc", 3)).toBe("abc");
  });

  it("should cut to the cap with an ellipsis when the text is longer", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
  });

  it("should never split a surrogate pair when the cut falls inside one", () => {
    const clipped = clip(`ab${"😀".repeat(3)}`, 4);

    expect(clipped).toBe("ab…");
    expect(clipped.length).toBeLessThanOrEqual(4);
    expect(clipped.isWellFormed()).toBe(true);
  });
});

describe("gitBlobSha1", () => {
  it("should hash the bytes as git names a blob when given its contents", () => {
    expect(gitBlobSha1(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("docmosisCommand", () => {
  it("should look the CLI up beside the node it runs on first, and there alone when there is no PATH", () => {
    expect(docmosisCommand({ PATH: "/usr/bin" }, "/nvm/bin/node")).toEqual({ cmd: "docmosis", env: { PATH: "/nvm/bin:/usr/bin" } });
    expect(docmosisCommand({}, "/nvm/bin/node").env.PATH).toBe("/nvm/bin");
  });
});

describe("pruneCache", () => {
  it("should remove the oldest blobs but never the one in hand when the cache is past its limit", async () => {
    // Arrange
    const dir = blobCacheDir({ HOME: home });
    fs.mkdirSync(dir, { recursive: true });
    const write = (name: string, ageSeconds: number) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.alloc(100));
      const when = new Date(Date.now() - ageSeconds * 1000);
      fs.utimesSync(file, when, when);
      return file;
    };
    const newest = write("a.docx", 0);
    const middle = write("b.docx", 10);
    const oldest = write("c.docx", 20);
    fs.mkdirSync(path.join(dir, "not-a-blob"));

    // Act
    await pruneCache(fs.promises, dir, oldest, 150);

    // Assert
    expect(fs.existsSync(newest)).toBe(true);
    expect(fs.existsSync(middle)).toBe(false);
    expect(fs.existsSync(oldest)).toBe(true);
  });

  it("should do nothing when there is no cache yet", async () => {
    await expect(pruneCache(fs.promises, path.join(home, "none"), "x")).resolves.toBeUndefined();
  });
});
