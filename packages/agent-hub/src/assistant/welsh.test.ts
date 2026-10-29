import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WelshAnswer } from "../api.ts";
import { createWelshRunner, failureDetail, parseWelshFrame, runWelsh, signInNeeded, type WelshDeps, welshArgs, welshOutputs, welshPaths } from "./welsh.ts";

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

  it("should give a repo as an absolute path under the workspace, and the request a path in the job's directory", () => {
    expect(welshArgs(frame("scan", { repo: "apps/cath/cath-service" }), WS, paths)).toEqual([
      "scan",
      "--service",
      "cath",
      "--repo",
      `${WS}/apps/cath/cath-service`,
      "--out",
      "/tmp/j/request.xlsx"
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
    expect(welshOutputs(frame("scan", {}), paths, "2026-10-29")).toEqual([{ path: "/tmp/j/request.xlsx", name: "cath-welsh-request-2026-10-29.xlsx" }]);
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
    expect(failureDetail("", 127)).toMatch(/does not have the Welsh tools yet/);
    expect(failureDetail(`welsh x: ${"y".repeat(600)}`, 2)).toHaveLength(500);
  });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "welsh-ws-"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "welsh"), "#!/bin/sh\n");
  return dir;
}

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
  const d: WelshDeps = { api, id: "va", env: {}, workspace: workspace(), now: () => new Date("2026-10-29T09:00:00Z"), run: vi.fn(), ...over };
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
    const frame = parseWelshFrame({ job_id: JOB, kind: "scan", product: "cath", args: {} });

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

  it("should say the tools are missing when the workspace has no scripts/welsh, without running anything", async () => {
    const { d, answers } = deps({ workspace: mkdtempSync(join(tmpdir(), "welsh-empty-")) });
    await runWelsh(d, parseWelshFrame({ job_id: JOB, kind: "info", product: "cath", args: {} }) as NonNullable<ReturnType<typeof parseWelshFrame>>);
    expect(d.run).not.toHaveBeenCalled();
    expect(answers[0]?.body).toMatchObject({ error: "failed", detail: expect.stringMatching(/does not have the Welsh tools/) });
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
    expect(calls[0]?.url).toBe(`http://hub/api/virtual/va/welsh/${JOB}/files`);
    expect((calls[0]?.init.headers as Record<string, string>)["X-File-Name"]).toBe(encodeURIComponent("cath ŵ.xlsx"));
    expect(calls[2]?.init.body).toBe(JSON.stringify({ result: { total: 0 } }));

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
