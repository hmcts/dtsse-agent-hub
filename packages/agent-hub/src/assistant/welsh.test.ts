import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WelshAnswer } from "../wire.ts";
import {
  createWelshRunner,
  failureDetail,
  fitResult,
  NOT_LOADED,
  parseWelshFrame,
  prepareWelsh,
  runWelsh,
  STILL_PREPARING,
  signInNeeded,
  type WelshDeps,
  welshArgs,
  welshOutputs,
  welshPaths
} from "./welsh.ts";

const JOB = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FILE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const WS = "/workspace/cft-workspace";
const paths = welshPaths("/tmp/j", { file_name: "return.xlsx" });

describe("parseWelshFrame", () => {
  it("should take a search, defaulting its mode", () => {
    expect(parseWelshFrame({ job_id: JOB, kind: "search", product: "cath", args: { query: " back " } })).toEqual({
      job_id: JOB,
      kind: "search",
      product: "cath",
      query: "back",
      mode: "contains"
    });
  });

  it("should refuse an unknown kind, a bad product, an extra argument, or a repo of another product", () => {
    expect(parseWelshFrame({ job_id: JOB, kind: "translate", product: "cath", args: {} })).toBeNull();
    expect(parseWelshFrame({ job_id: JOB, kind: "info", product: "../cath", args: {} })).toBeNull();
    expect(parseWelshFrame({ job_id: JOB, kind: "info", product: "cath", args: { query: "x" } })).toBeNull();
    expect(parseWelshFrame({ job_id: JOB, kind: "scan", product: "cath", args: { repo: "apps/pcs/pcs-frontend" } })).toBeNull();
    expect(parseWelshFrame({ job_id: "nope", kind: "info", product: "cath", args: {} })).toBeNull();
    expect(parseWelshFrame("not a frame")).toBeNull();
  });

  it("should take the refs a request leaves out, and refuse one that is not a ref", () => {
    expect(parseWelshFrame({ job_id: JOB, kind: "request", product: "cath", args: { leave_out: ["CY-ABCDEF12"] } })?.leave_out).toEqual(["CY-ABCDEF12"]);
    expect(parseWelshFrame({ job_id: JOB, kind: "request", product: "cath", args: {} })?.leave_out).toEqual([]);
    expect(parseWelshFrame({ job_id: JOB, kind: "request", product: "cath", args: { leave_out: ["--pr"] } })).toBeNull();
    expect(parseWelshFrame({ job_id: JOB, kind: "request", product: "cath", args: { leave_out: "CY-ABCDEF12" } })).toBeNull();
  });

  it("should need the English to keep", () => {
    expect(parseWelshFrame({ job_id: JOB, kind: "keep_english", product: "cath", args: { strings: ["Rolls Building"] } })?.strings).toEqual(["Rolls Building"]);
    expect(parseWelshFrame({ job_id: JOB, kind: "keep_english", product: "cath", args: {} })).toBeNull();
  });

  it("should need a file for an import and keep only a safe file name", () => {
    expect(parseWelshFrame({ job_id: JOB, kind: "import", product: "cath", args: {} })).toBeNull();
    expect(parseWelshFrame({ job_id: JOB, kind: "import", product: "cath", args: { file_id: FILE }, file_name: "../x.xlsx" })?.file_name).toBe(
      "welsh-return.xlsx"
    );
    expect(parseWelshFrame({ job_id: JOB, kind: "import", product: "cath", args: { file_id: FILE }, file_name: "Ymateb Hydref.xlsx" })?.file_name).toBe(
      "Ymateb Hydref.xlsx"
    );
  });

  it("should take a story preview's strings and choices, and refuse a string carrying a line break", () => {
    const frame = {
      job_id: JOB,
      kind: "story_preview",
      product: "cath",
      args: { key: "PUB-1", strings: ["Continue"], choices: [{ ref: "CY-ABCDEF12", row_id: "0123456789" }] }
    };
    expect(parseWelshFrame(frame)?.strings).toEqual(["Continue"]);
    expect(parseWelshFrame({ ...frame, args: { ...frame.args, strings: ["a\nb"] } })).toBeNull();
    expect(parseWelshFrame({ ...frame, args: { ...frame.args, strings: [] } })).toBeNull();
    expect(parseWelshFrame({ ...frame, args: { ...frame.args, choices: [{ ref: "x", row_id: "y" }] } })).toBeNull();
    expect(parseWelshFrame({ ...frame, args: { ...frame.args, key: "not a key" } })).toBeNull();
  });
});

describe("welshArgs", () => {
  const frame = (kind: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseWelshFrame({ job_id: JOB, kind, product: "cath", args, ...extra }) as NonNullable<ReturnType<typeof parseWelshFrame>>;

  it("should put whatever the person typed after --, so it can never be read as an option", () => {
    expect(welshArgs(frame("search", { query: "--all", mode: "exact" }), WS, paths)).toEqual([
      "search",
      "--service",
      "cath",
      "--exact",
      "--limit",
      "25",
      "--",
      "--all"
    ]);
  });

  it("should give a repo as an absolute path under the workspace, and list a scan's strings without making a spreadsheet", () => {
    expect(welshArgs(frame("scan", { repo: "apps/cath/cath-service" }), WS, paths)).toEqual([
      "scan",
      "--service",
      "cath",
      "--repo",
      `${WS}/apps/cath/cath-service`,
      "--limit",
      "300"
    ]);
  });

  it("should make a request in the job's directory without the strings a BA left out", () => {
    expect(welshArgs(frame("request", { leave_out: ["CY-ABCDEF12", "CY-12345678"] }), WS, paths)).toEqual([
      "scan",
      "--service",
      "cath",
      "--limit",
      "0",
      "--leave-out",
      "CY-ABCDEF12",
      "--leave-out",
      "CY-12345678",
      "--out",
      "/tmp/j/request.xlsx"
    ]);
  });

  it("should keep English as it is through a draft pull request, the English after --", () => {
    expect(welshArgs(frame("keep_english", { strings: ["--pr", "Rolls Building"] }), WS, paths)).toEqual([
      "keep-english",
      "--service",
      "cath",
      "--pr",
      "--",
      "--pr",
      "Rolls Building"
    ]);
  });

  it("should apply from the catalogue or from the uploaded return, with the BA's choices", () => {
    expect(welshArgs(frame("apply", { choices: [{ ref: "CY-ABCDEF12", row_id: "0123456789" }] }), WS, paths)).toEqual([
      "apply",
      "--service",
      "cath",
      "--from",
      "catalogue",
      "--choose",
      "CY-ABCDEF12=0123456789",
      "--pr"
    ]);
    expect(welshArgs(frame("apply_preview", { file_id: FILE }, { file_name: "return.xlsx" }), WS, paths)).toContain("/tmp/j/return.xlsx");
  });

  it("should import with a PR and its queries file, and check without either", () => {
    expect(welshArgs(frame("import", { file_id: FILE }), WS, paths)).toEqual([
      "import",
      "--service",
      "cath",
      "--pr",
      "--queries-out",
      "/tmp/j/queries.xlsx",
      "--",
      "/tmp/j/return.xlsx"
    ]);
    expect(welshArgs(frame("import_check", { file_id: FILE }), WS, paths)).toEqual(["import", "--service", "cath", "--dry-run", "--", "/tmp/j/return.xlsx"]);
  });

  it("should run each story step", () => {
    expect(welshArgs(frame("story_candidates", { key: "PUB-1" }), WS, paths)).toEqual(["story", "--service", "cath", "--", "PUB-1"]);
    expect(welshArgs(frame("story_preview", { key: "PUB-1", strings: ["Continue"] }), WS, paths)).toEqual([
      "story",
      "--service",
      "cath",
      "--strings",
      "/tmp/j/strings.txt",
      "--",
      "PUB-1"
    ]);
    expect(welshArgs(frame("story_write", { key: "PUB-1" }), WS, paths)).toEqual([
      "story",
      "--service",
      "cath",
      "--write",
      "--out",
      "/tmp/j/request.xlsx",
      "--",
      "PUB-1"
    ]);
    expect(welshArgs(frame("info", {}), WS, paths)).toEqual(["info", "--service", "cath"]);
  });

  it("should name each spreadsheet for the person downloading it", () => {
    expect(welshOutputs(frame("request", {}), paths, "2026-10-29")).toEqual([{ path: "/tmp/j/request.xlsx", name: "cath-welsh-request-2026-10-29.xlsx" }]);
    expect(welshOutputs(frame("scan", {}), paths, "2026-10-29")).toEqual([]);
    expect(welshOutputs(frame("import", { file_id: FILE }, { file_name: "return.xlsx" }), paths, "2026-10-29")[0]?.name).toBe("return-queries.xlsx");
    expect(welshOutputs(frame("story_write", { key: "PUB-1" }), paths, "2026-10-29")[0]?.name).toBe("PUB-1-welsh-request-2026-10-29.xlsx");
    expect(welshOutputs(frame("search", { query: "x" }), paths, "2026-10-29")).toEqual([]);
  });
});

describe("failures", () => {
  it("should tell a missing GitHub or Atlassian sign-in from any other failure", () => {
    expect(signInNeeded("gh pr create failed: To get started with GitHub CLI, please run:  gh auth login")).toMatch(/GitHub/);
    expect(signInNeeded('twg jira workitem get failed: {"error":{"code":"AUTH_REQUIRED"}}')).toMatch(/Atlassian/);
    expect(signInNeeded("no product apps/zzz in this workspace")).toBeNull();
  });

  it("should give the script's own message, without its usage line or a stack", () => {
    expect(failureDetail("welsh scan: no product apps/zzz in this workspace\n  usage: scripts/welsh scan …", 2)).toBe("no product apps/zzz in this workspace");
    expect(failureDetail("Error: could not clone hmcts/x\n    at ensureClone (clones.ts:20)", 1)).toBe("could not clone hmcts/x");
    expect(failureDetail("", 1)).toBe("That did not work. Try again.");
    expect(failureDetail("", 127)).toMatch(/could not start the Welsh tools/);
    expect(failureDetail(`welsh x: ${"y".repeat(600)}`, 2)).toHaveLength(500);
  });
});

/** Where the test's stand-in for the pod's copy of the plugin is, and the install that hands it out. */
const COPY = "/workspace/.agent-hub-plugins/welsh-abc";
const install = vi.fn(() => COPY);

const TICKED = { AGENT_HUB_PLUGINS: "pcs,welsh" };

function deps(over: Partial<WelshDeps> = {}) {
  const answers: { id: string; body: WelshAnswer }[] = [];
  const files: { name: string; bytes: string }[] = [];
  const api = {
    putWelsh: vi.fn(async (_v: string, id: string, body: WelshAnswer) => {
      answers.push({ id, body });
      return null;
    }),
    putWelshFile: vi.fn(async (_v: string, _j: string, name: string, bytes: Uint8Array) => {
      files.push({ name, bytes: Buffer.from(bytes).toString() });
      return { file_id: FILE };
    }),
    welshFile: vi.fn(async () => new TextEncoder().encode("PK-return"))
  };
  const d: WelshDeps = { api, id: "va", env: TICKED, workspace: WS, install, now: () => new Date("2026-10-29T09:00:00Z"), run: vi.fn(), ...over };
  return { d, api, answers, files };
}

describe("runWelsh", () => {
  it("should run the script, upload the spreadsheet it made, then answer with what it printed and said", async () => {
    // Arrange
    const { d, answers, files } = deps({
      run: vi.fn(async (_cmd: string, args: string[]) => {
        writeFileSync(args[args.indexOf("--out") + 1] as string, "PK-request");
        return { code: 0, stdout: JSON.stringify({ summary: { toWlu: 3 } }), stderr: "3 new for the WLU." };
      })
    });
    const frame = parseWelshFrame({ job_id: JOB, kind: "request", product: "cath", args: {} });

    // Act
    await runWelsh(d, frame as NonNullable<typeof frame>);

    // Assert
    expect(files).toEqual([{ name: "cath-welsh-request-2026-10-29.xlsx", bytes: "PK-request" }]);
    expect(answers).toEqual([{ id: JOB, body: { result: { summary: { toWlu: 3 }, message: "3 new for the WLU." } } }]);
  });

  it("should fetch the uploaded return first and give the script its path", async () => {
    // Arrange
    let seen = "";
    const { d, api, answers } = deps({
      run: vi.fn(async (_cmd: string, args: string[]) => {
        seen = readFileSync(args.at(-1) as string, "utf8");
        return { code: 0, stdout: "{}", stderr: "" };
      })
    });
    const frame = parseWelshFrame({ job_id: JOB, kind: "import_check", product: "cath", args: { file_id: FILE }, file_name: "return.xlsx" });

    // Act
    await runWelsh(d, frame as NonNullable<typeof frame>);

    // Assert
    expect(api.welshFile).toHaveBeenCalledWith("va", FILE);
    expect(seen).toBe("PK-return");
    expect(answers[0]?.body).toEqual({ result: { message: "" } });
  });

  it("should answer signed_out for a missing sign-in and failed with the script's message otherwise", async () => {
    const out = deps({ run: vi.fn(async () => ({ code: 1, stdout: "", stderr: "Error: gh pr create failed: run gh auth login" })) });
    await runWelsh(out.d, parseWelshFrame({ job_id: JOB, kind: "apply", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    expect(out.answers[0]?.body).toMatchObject({ error: "signed_out" });

    const bad = deps({ run: vi.fn(async () => ({ code: 2, stdout: "", stderr: "welsh apply: verify refused 1 value(s)" })) });
    await runWelsh(bad.d, parseWelshFrame({ job_id: JOB, kind: "apply", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    expect(bad.answers[0]?.body).toEqual({ error: "failed", detail: "verify refused 1 value(s)" });

    const junk = deps({ run: vi.fn(async () => ({ code: 0, stdout: "not json", stderr: "" })) });
    await runWelsh(junk.d, parseWelshFrame({ job_id: JOB, kind: "info", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    expect(junk.answers[0]?.body).toMatchObject({ error: "failed" });
  });

  it("should run the pod's copy of the welsh plugin, told which workspace to work on, when the owner ticked it", async () => {
    const { d } = deps({ run: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" })) });
    await runWelsh(d, parseWelshFrame({ job_id: JOB, kind: "info", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    expect(install).toHaveBeenCalledWith("welsh", WS);
    expect(d.run).toHaveBeenCalledWith(join(COPY, "scripts", "welsh"), expect.any(Array), {
      env: expect.objectContaining({ CFT_WELSH_WORKSPACE: WS, AGENT_HUB_PLUGINS: "pcs,welsh" }),
      timeoutMs: expect.any(Number)
    });
  });

  it("should say Welsh is not turned on, without running anything, when the owner has not ticked the plugin", async () => {
    const { d, answers } = deps({ env: { AGENT_HUB_PLUGINS: "pcs" } });
    await runWelsh(d, parseWelshFrame({ job_id: JOB, kind: "info", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    expect(d.run).not.toHaveBeenCalled();
    expect(answers[0]?.body).toEqual({ error: "failed", detail: NOT_LOADED });
  });

  it("should not start a job, or its time limit, until the tools' first install has finished", async () => {
    // Arrange
    let installed: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      installed = resolve;
    });
    const { d, answers } = deps({ ready, run: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" })) });

    // Act
    const job = runWelsh(d, parseWelshFrame({ job_id: JOB, kind: "info", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = (d.run as ReturnType<typeof vi.fn>).mock.calls.length;
    installed();
    await job;

    // Assert
    expect(before).toBe(0);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(answers).toHaveLength(1);
  });

  it("should take the wait for the install out of the job's budget, and cut its own limit to what is left", async () => {
    // Arrange: the install finishes 13 minutes and 10 seconds into a 14-minute budget.
    let t = 0;
    const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    const ready = Promise.resolve().then(() => {
      t = 13 * 60_000 + 10_000;
    });
    const { d } = deps({ ready, run, clock: () => t });

    // Act
    await runWelsh(d, parseWelshFrame({ job_id: JOB, kind: "apply", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);

    // Assert: 50 seconds left, not apply's own 14 minutes.
    expect(run).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeoutMs: 50_000 }));
  });

  it("should answer that the tools are still being set up, running nothing, when the install leaves no time for the job", async () => {
    const { d, answers } = deps({ ready: new Promise<void>(() => {}), budgetMs: 40_000 });
    await runWelsh(d, parseWelshFrame({ job_id: JOB, kind: "info", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    expect(d.run).not.toHaveBeenCalled();
    expect(answers[0]?.body).toEqual({ error: "failed", detail: STILL_PREPARING });
  });

  it("should answer failed with the reason rather than throw when the plugin cannot be copied onto the pod", async () => {
    const { d, answers } = deps({
      install: () => {
        throw new Error("ENOSPC: no space left on device");
      }
    });
    await runWelsh(d, parseWelshFrame({ job_id: JOB, kind: "info", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    expect(d.run).not.toHaveBeenCalled();
    expect(answers[0]?.body).toEqual({ error: "failed", detail: "That did not work: ENOSPC: no space left on device" });
  });

  it("should answer failed rather than throw when fetching the return fails", async () => {
    const { d, api, answers } = deps({ run: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" })) });
    api.welshFile.mockRejectedValueOnce(new Error("404 no such file"));
    await runWelsh(
      d,
      parseWelshFrame({ job_id: JOB, kind: "import", product: "cath", args: { file_id: FILE } }) as NonNullable<ReturnType<typeof parseWelshFrame>>
    );
    expect(answers[0]?.body).toEqual({ error: "failed", detail: "That did not work: 404 no such file" });
  });
});

describe("prepareWelsh", () => {
  it("should install the tools' dependencies ahead of any job when the owner ticked the plugin", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await prepareWelsh({ run, env: TICKED, workspace: WS, install });
    expect(run).toHaveBeenCalledWith(join(COPY, "scripts", "welsh"), ["deps"], {
      env: expect.objectContaining({ CFT_WELSH_WORKSPACE: WS }),
      timeoutMs: 15 * 60_000
    });
  });

  it("should do nothing when the plugin is not ticked, and say rather than throw when the install fails", async () => {
    const idle = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await prepareWelsh({ run: idle, env: { AGENT_HUB_PLUGINS: "pcs" }, workspace: WS, install });
    expect(idle).not.toHaveBeenCalled();

    const said: string[] = [];
    const failing = vi.fn(async () => ({ code: 1, stdout: "", stderr: "npm ERR! network" }));
    await prepareWelsh({ run: failing, env: TICKED, workspace: WS, install, say: (m) => said.push(m) });
    expect(said).toEqual(["welsh: could not install the tools' dependencies (exit 1): npm ERR! network"]);
  });
});

describe("createWelshRunner", () => {
  it("should run long jobs one at a time in order, quick ones beside them, and ignore a bad frame", async () => {
    // Arrange
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { d } = deps({
      run: vi.fn(async (_cmd: string, args: string[]) => {
        order.push(`start ${args[0]}`);
        if (args[0] === "scan") {
          await gate;
        }
        order.push(`end ${args[0]}`);
        return { code: 0, stdout: "{}", stderr: "" };
      })
    });
    const say = vi.fn();
    const runner = createWelshRunner({ ...d, say });

    // Act
    runner.welsh({ job_id: JOB, kind: "scan", product: "cath", args: {} });
    runner.welsh({ job_id: JOB, kind: "story_candidates", product: "cath", args: { key: "PUB-1" } });
    runner.welsh({ job_id: JOB, kind: "search", product: "cath", args: { query: "x" } });
    runner.welsh({ job_id: JOB, kind: "nonsense", product: "cath", args: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await runner.idle();

    // Assert
    const at = (step: string) => order.indexOf(step);
    expect(at("end search")).toBeLessThan(at("end scan"));
    expect(at("start story")).toBeGreaterThan(at("end scan"));
    expect(order).toHaveLength(6);
    expect(say).toHaveBeenCalledWith(expect.stringMatching(/ignoring a Welsh job/));
  });
});

describe("the client's Welsh calls", () => {
  it("should send a spreadsheet as raw bytes with its name, fetch one back, and send the answer as JSON", async () => {
    // Arrange
    const { createApi, ApiError } = await import("../api.ts");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/files") && init?.method === "PUT") {
        return new Response(JSON.stringify({ file_id: FILE }), { status: 201 });
      }
      if (String(url).includes("/welsh/files/")) {
        return new Response(new Uint8Array([0x50, 0x4b]), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const api = createApi({ baseUrl: "http://hub", launchToken: `launch-${"s".repeat(16)}`, fetchImpl });

    // Act
    const put = await api.putWelshFile("va", JOB, "cath ŵ.xlsx", new Uint8Array([1, 2]));
    const got = await api.welshFile("va", FILE);
    await api.putWelsh("va", JOB, { result: { total: 0 } });

    // Assert
    expect(put).toEqual({ file_id: FILE });
    expect(Array.from(got)).toEqual([0x50, 0x4b]);
    const [upload, , answer] = calls;
    expect(upload?.url).toBe(`http://hub/api/virtual/va/welsh/${JOB}/files`);
    expect((upload?.init.headers ?? {}) as Record<string, string>).toMatchObject({ "X-File-Name": encodeURIComponent("cath ŵ.xlsx") });
    expect(answer?.init.body).toBe(JSON.stringify({ result: { total: 0 } }));

    // A refused upload is an ApiError, as every other call's is.
    const refusing = createApi({
      baseUrl: "http://hub",
      launchToken: `launch-${"s".repeat(16)}`,
      fetchImpl: (async () => new Response(JSON.stringify({ error: "too big" }), { status: 413 })) as unknown as typeof fetch
    });
    await expect(refusing.putWelshFile("va", JOB, "a.xlsx", new Uint8Array([1]))).rejects.toBeInstanceOf(ApiError);
  });

  it("should run with the defaults for what it says and the date", async () => {
    const { d, answers } = deps({ run: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" })) });
    const { now: _now, say: _say, ...plain } = d;
    await runWelsh(plain, parseWelshFrame({ job_id: JOB, kind: "scan", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    expect(answers[0]?.body).toEqual({ result: { message: "" } });
    const runner = createWelshRunner(plain);
    runner.welsh("nonsense");
    await runner.idle();
  });
});

describe("fitResult", () => {
  const entry = (i: number) => ({ ref: `CY-${String(i).padStart(8, "0")}`, english: "x".repeat(200), where: "y".repeat(300) });

  it("should halve a scan's lists until the result fits, keeping its full counts", () => {
    const result = { summary: { toWlu: 300 }, toWlu: Array.from({ length: 300 }, (_, i) => entry(i)), fromCatalogue: [entry(0)], message: "m" };
    const fitted = fitResult(result, 50_000);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(50_000);
    expect((fitted.toWlu as unknown[]).length).toBeLessThan(300);
    expect((fitted.toWlu as unknown[]).length).toBeGreaterThan(0);
    expect(fitted.summary).toEqual({ toWlu: 300 });
  });

  it("should leave a result that fits, or one with no lists to shorten, as it is", () => {
    const small = { toWlu: [entry(1)], message: "m" };
    expect(fitResult(small, 50_000)).toBe(small);
    const noLists = { message: "z".repeat(100) };
    expect(fitResult(noLists, 10)).toBe(noLists);
  });
});
