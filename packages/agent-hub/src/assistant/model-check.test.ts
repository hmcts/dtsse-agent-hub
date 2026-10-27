// The model check: how one request's outcome is classified, what it runs with, and how a check is run and reported.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelCheckBody } from "../api.ts";
import { CHECKED_MODELS, type CheckRun, type CheckRunner, checkArgs, checkEnv, checkModels, classify, createModelChecker, runClaude } from "./model-check.ts";

const SECRET = "sk-ant-oat01-a-very-secret-token-value";
const BEDROCK_KEY = "ABSKa-very-secret-bedrock-key-value";

const ok = (text = "OK"): CheckRun => ({ code: 0, timedOut: false, stdout: JSON.stringify({ type: "result", is_error: false, result: text }), stderr: "" });
const failed = (result: string, stderr = ""): CheckRun => ({
  code: 1,
  timedOut: false,
  stdout: JSON.stringify({ type: "result", is_error: true, result }),
  stderr
});

describe("classify", () => {
  it("should be available when the model answered and the result is not an error", () => {
    expect(classify(ok())).toBe("available");
  });

  it.each([
    ["a 404 for the model", failed('API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}')],
    ["a 403", failed("API Error: 403 forbidden")],
    ["a 400", failed("API Error: 400 The provided model identifier is invalid.")],
    ["Claude Code's own wording", failed("There's an issue with the selected model (x). It may not exist or you may not have access to it.")],
    [
      "Bedrock refusing access",
      { code: 1, timedOut: false, stdout: "", stderr: "AccessDeniedException: You don't have access to the model with the specified model ID." }
    ],
    ["a permission error", failed('{"error":{"type":"permission_error"}}')]
  ])("should be unavailable when the API refused the model with %s", (_what, run) => {
    expect(classify(run)).toBe("unavailable");
  });

  it.each([
    ["it timed out", { code: null, timedOut: true, stdout: "", stderr: "" }],
    ["it was throttled", failed("API Error: 429 Too many requests")],
    ["the API failed", failed("API Error: 500 Internal server error")],
    ["the API was overloaded", failed('API Error: 529 {"type":"overloaded_error"}')],
    ["the credential was refused", failed('API Error: 401 {"type":"authentication_error","message":"invalid x-api-key"}')],
    ["the network failed", { code: 1, timedOut: false, stdout: "", stderr: "Error: connect ECONNREFUSED 10.0.0.1:443" }],
    ["the output is not a result it recognises", { code: 0, timedOut: false, stdout: "not json", stderr: "" }],
    ["it exited cleanly with an error result", { ...failed("API Error: 503 unavailable"), code: 0 }]
  ])("should be unknown when %s", (_what, run) => {
    expect(classify(run)).toBe("unknown");
  });
});

describe("checkEnv", () => {
  const parent = {
    PATH: "/opt/node/bin:/usr/bin",
    AGENT_HUB_LAUNCH_TOKEN: "lt-x",
    AGENT_HUB_CONVERSATION_ID: "c",
    CLAUDE_CODE_MESSAGING_TOKEN: "m",
    HOME: "/home/agent"
  };

  it("should carry the Claude token and nothing of agent-hub's when the pod is on its owner's licence", () => {
    const env = checkEnv("own_licence", SECRET, "/tmp/check", parent);

    expect(env).toEqual({
      PATH: "/opt/node/bin:/usr/bin",
      HOME: "/tmp/check",
      CLAUDE_CONFIG_DIR: path.join("/tmp/check", ".claude"),
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_OAUTH_TOKEN: SECRET
    });
  });

  it("should carry the Bedrock key in hai's default region when the pod is on Bedrock with no region set", () => {
    const env = checkEnv("bedrock", BEDROCK_KEY, "/tmp/check", parent);

    expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-west-2", AWS_BEARER_TOKEN_BEDROCK: BEDROCK_KEY, HOME: "/tmp/check" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.keys(env).some((key) => key.startsWith("AGENT_HUB_"))).toBe(false);
  });

  it("should keep the pod's region when one is set", () => {
    expect(checkEnv("bedrock", BEDROCK_KEY, "/tmp/check", { AWS_REGION: "us-east-1" }).AWS_REGION).toBe("us-east-1");
  });

  it("should fall back to a system PATH when the pod has none", () => {
    expect(checkEnv("bedrock", BEDROCK_KEY, "/tmp/check", {}).PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});

describe("checkArgs", () => {
  it("should ask for one turn with no tools, no MCP servers, no skills and nothing kept when it is built", () => {
    const args = checkArgs("eu.anthropic.claude-opus-5-5[1m]");

    expect(args.slice(0, 3)).toEqual(["-p", "--model", "eu.anthropic.claude-opus-5-5[1m]"]);
    expect(args).toEqual(expect.arrayContaining(["--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });
});

describe("checkModels", () => {
  function recorder(answer: (model: string) => CheckRun | Promise<CheckRun>) {
    const calls: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }[] = [];
    let inFlight = 0;
    let peak = 0;
    const run: CheckRunner = async (args, opts) => {
      calls.push({ args, ...opts });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Every call is still in flight here, so the peak counts how many run at once.
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await answer(args[2] ?? "");
      } finally {
        inFlight -= 1;
      }
    };
    return { calls, run, peak: () => peak };
  }

  const api = (value: string | null) => ({ getCredential: async () => value });

  it("should ask every model the route has an id for, and call Fable unavailable without asking, when the pod is on Bedrock", async () => {
    const { calls, run } = recorder((launched) => (launched.includes("haiku") ? failed("API Error: 404 not_found_error") : ok()));

    const results = await checkModels({ api: api(BEDROCK_KEY), id: "va-1", env: { AWS_REGION: "eu-west-2" }, run });

    expect(results).toEqual([
      { model: "claude-sonnet-5-5", status: "available" },
      { model: "claude-opus-5-5", status: "available" },
      { model: "claude-haiku-5-5", status: "unavailable" },
      { model: "claude-fable-5-1", status: "unavailable" }
    ]);
    expect(calls.map((call) => call.args[2])).toEqual([
      "eu.anthropic.claude-sonnet-5-5[1m]",
      "eu.anthropic.claude-opus-5-5[1m]",
      "eu.anthropic.claude-haiku-5-5"
    ]);
  });

  it("should ask every catalogue model by its own id when the pod is on its owner's licence", async () => {
    const { calls, run } = recorder(() => ok());

    const results = await checkModels({ api: api(SECRET), id: "va-1", env: { AGENT_HUB_MODEL_ROUTE: "own_licence" }, run });

    expect(results?.map((result) => result.status)).toEqual(["available", "available", "available", "available"]);
    expect(calls.map((call) => call.args[2])).toEqual([...CHECKED_MODELS]);
    expect(calls.every((call) => call.env.CLAUDE_CODE_OAUTH_TOKEN === SECRET && call.timeoutMs === 60_000)).toBe(true);
  });

  it("should run at most two at a time, each in its own empty directory that is gone afterwards", async () => {
    const { calls, run, peak } = recorder(() => ok());

    await checkModels({ api: api(SECRET), id: "va-1", env: { AGENT_HUB_MODEL_ROUTE: "own_licence" }, run });

    expect(peak()).toBe(2);
    expect(new Set(calls.map((call) => call.cwd)).size).toBe(calls.length);
    expect(calls.every((call) => call.env.HOME === call.cwd && !fs.existsSync(call.cwd))).toBe(true);
  });

  it("should never put the credential in an argument or the log when it checks", async () => {
    const said: string[] = [];
    const { calls, run } = recorder(() => failed(`API Error: 404 echoing ${SECRET}`));

    await checkModels({ api: api(SECRET), id: "va-1", env: { AGENT_HUB_MODEL_ROUTE: "own_licence" }, run, say: (m) => said.push(m) });

    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(SECRET);
    expect(said.join("\n")).not.toContain(SECRET);
    expect(said.join("\n")).toContain("claude-opus-5-5 unavailable");
  });

  it("should call a model unknown when its run throws", async () => {
    const run: CheckRunner = async () => {
      throw new Error("spawn claude ENOENT");
    };

    const results = await checkModels({ api: api(SECRET), id: "va-1", env: { AGENT_HUB_MODEL_ROUTE: "own_licence" }, run });

    expect(results?.every((result) => result.status === "unknown")).toBe(true);
  });

  it("should check nothing and answer null when no credential is stored yet", async () => {
    const { calls, run } = recorder(() => ok());

    expect(await checkModels({ api: api(null), id: "va-1", env: {}, run })).toBeNull();
    expect(await checkModels({ api: api(""), id: "va-1", env: {}, run })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("should ask the hub for the credential the route pays with", async () => {
    const asked: string[] = [];
    const getCredential = async (_id: string, kind: string) => {
      asked.push(kind);
      return null;
    };

    await checkModels({ api: { getCredential }, id: "va-1", env: { AGENT_HUB_MODEL_ROUTE: "own_licence" } });
    await checkModels({ api: { getCredential }, id: "va-1", env: {} });

    expect(asked).toEqual(["claude", "bedrock"]);
  });
});

describe("createModelChecker", () => {
  it("should report what the check found when it is asked for", async () => {
    const posted: ModelCheckBody[] = [];
    const checker = createModelChecker({
      api: {
        getCredential: async () => SECRET,
        postModels: async (_id, body) => {
          posted.push(body);
          return null;
        }
      },
      id: "va-1",
      env: { AGENT_HUB_MODEL_ROUTE: "own_licence" },
      run: async () => ok()
    });

    await checker.request();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.models).toHaveLength(CHECKED_MODELS.length);
  });

  it("should run one check behind the one running, however many are asked for meanwhile", async () => {
    let checks = 0;
    const checker = createModelChecker({
      api: {
        getCredential: async () => {
          checks += 1;
          return SECRET;
        },
        postModels: async () => null
      },
      id: "va-1",
      env: { AGENT_HUB_MODEL_ROUTE: "own_licence" },
      run: async () => ok()
    });

    const first = checker.request();
    checker.request();
    checker.request();
    await first;
    await checker.request();

    expect(checks).toBe(3);
  });

  it("should report nothing when there is no credential to check with", async () => {
    let posts = 0;
    const checker = createModelChecker({
      api: {
        getCredential: async () => null,
        postModels: async () => {
          posts += 1;
          return null;
        }
      },
      id: "va-1",
      env: {}
    });

    await checker.request();

    expect(posts).toBe(0);
  });

  it("should say so rather than throw when the report fails", async () => {
    const said: string[] = [];
    const checker = createModelChecker({
      api: {
        getCredential: async () => SECRET,
        postModels: async () => {
          throw new Error("hub 503");
        }
      },
      id: "va-1",
      env: { AGENT_HUB_MODEL_ROUTE: "own_licence" },
      run: async () => ok(),
      say: (m) => said.push(m)
    });

    await expect(checker.request()).resolves.toBeUndefined();
    expect(said.at(-1)).toBe("model check failed: hub 503");
  });
});

describe("runClaude", () => {
  let bin: string;

  // A `claude` that answers by its model argument: `ok` prints a result, `slow` outlives the timeout, `bad` fails.
  beforeAll(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-claude-"));
    fs.writeFileSync(
      path.join(bin, "claude"),
      [
        "#!/bin/sh",
        'case "$3" in',
        '  ok) printf \'{"type":"result","is_error":false,"result":"OK %s"}\' "$PWD" ;;',
        "  slow) sleep 5 ;;",
        "  *) echo 'API Error: 404 not_found_error' >&2; exit 1 ;;",
        "esac",
        ""
      ].join("\n"),
      { mode: 0o755 }
    );
  });

  afterAll(() => {
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const env = () => ({ PATH: `${bin}:/usr/bin:/bin` });

  it("should answer what claude printed, from the directory it was given, when it exits cleanly", async () => {
    const outcome = await runClaude(["-p", "--model", "ok"], { cwd: os.tmpdir(), env: env(), timeoutMs: 5000 });

    expect(outcome).toMatchObject({ code: 0, timedOut: false });
    expect(classify(outcome)).toBe("available");
    expect(outcome.stdout).toContain(fs.realpathSync(os.tmpdir()));
  });

  it("should answer its exit status and what it said when it fails", async () => {
    const outcome = await runClaude(["-p", "--model", "bad"], { cwd: os.tmpdir(), env: env(), timeoutMs: 5000 });

    expect(outcome).toMatchObject({ code: 1, timedOut: false });
    expect(classify(outcome)).toBe("unavailable");
  });

  it("should say it timed out when claude outlives the timeout", async () => {
    const outcome = await runClaude(["-p", "--model", "slow"], { cwd: os.tmpdir(), env: env(), timeoutMs: 200 });

    expect(outcome.timedOut).toBe(true);
    expect(classify(outcome)).toBe("unknown");
  });

  it("should answer no status and the error when claude is not on PATH", async () => {
    const outcome = await runClaude(["-p"], { cwd: os.tmpdir(), env: { PATH: "/nonexistent" }, timeoutMs: 5000 });

    expect(outcome).toMatchObject({ code: null, timedOut: false });
    expect(outcome.stderr).toContain("ENOENT");
  });
});
