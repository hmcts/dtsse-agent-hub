// Which Claude models the owner's own credential can use on this pod's route, found by asking each one, and told to the
// hub so the Assistant's composer offers only those. See Model access in dtsse-agent-hub's docs/agent-api.md.
import { execFile } from "node:child_process";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, ModelCheckResult, ModelCheckStatus } from "../api.ts";
import type { Env } from "../env.ts";
import { launcherModel } from "./models.ts";

/**
 * Every model the hub's catalogue holds, in its order: `src/assistant/models.ts` in the service. Mirrored by hand,
 * because this package cannot import from the app; a model only one side lists is one the hub ignores in a report or
 * one nobody asks about, and either way is offered no differently than before it was listed.
 */
export const CHECKED_MODELS: readonly string[] = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

/** How long one model is given to answer. A cold Bedrock profile can take tens of seconds for its first token. */
export const CHECK_TIMEOUT_MS = 60_000;
/** How many models are asked at once. Each is a `claude` process of a couple of hundred megabytes, beside the chats. */
export const CHECK_CONCURRENCY = 2;
/** How often a running pod checks again with nothing having changed: entitlements move rarely, and each check costs. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** What one model's request came to, as the runner saw it. */
export type CheckRun = { code: number | null; timedOut: boolean; stdout: string; stderr: string };

export type CheckRunner = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<CheckRun>;

/**
 * A refusal of the model itself, which takes it off the person's list: what Claude Code says when the API answers 400,
 * 403 or 404 for a model, and what Bedrock says when the account has no access to it. Anything not on this list is
 * `unknown`, because a mistake here in the other direction would take a model away from someone who can use it.
 */
const REFUSED: readonly RegExp[] = [
  /\bAPI Error: (400|403|404)\b/i,
  /\b(not_found_error|permission_error)\b/,
  /may not exist or you may not have access/i,
  /\bAccessDeniedException\b/,
  /\bdon'?t have access to the model\b/i,
  /\bmodel identifier is invalid\b/i,
  /\bnot (entitled|authorized|available) (to|for|on)\b.*\bmodel\b/i,
  /\bmodel\b.*\b(not found|does not exist|is not supported|not available)\b/i
];

/** Claude Code's JSON result, where it printed one. */
function parseResult(stdout: string): { isError: boolean; text: string } | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { is_error?: unknown; result?: unknown };
    return typeof parsed === "object" && parsed !== null ? { isError: parsed.is_error === true, text: String(parsed.result ?? "") } : null;
  } catch {
    return null;
  }
}

/**
 * `available` only for a run that exited cleanly with a result that is not an error. `unavailable` only for a refusal
 * of the model on `REFUSED`. Everything else — a timeout, throttling, a 5xx, a network error, a credential the API
 * would not take, output this does not recognise — is `unknown`, which the hub never lets take a model away.
 */
export function classify(run: CheckRun): ModelCheckStatus {
  if (run.timedOut) {
    return "unknown";
  }
  const result = parseResult(run.stdout);
  if (run.code === 0 && result !== null && !result.isError) {
    return "available";
  }
  const said = `${result?.text ?? run.stdout}\n${run.stderr}`;
  return REFUSED.some((shape) => shape.test(said)) ? "unavailable" : "unknown";
}

/**
 * The environment one request runs in, built from nothing rather than from this process's: only `PATH` to find
 * `claude`, a `HOME` and `CLAUDE_CONFIG_DIR` in the empty directory so no user settings, hooks, plugins or MCP servers
 * load, and the one credential the route pays with, as hai would hand it to `claude`. Nothing of agent-hub's reaches
 * it, so no hook could register the request as a session even if one were configured.
 */
export function checkEnv(route: "own_licence" | "bedrock", credential: string, dir: string, env: Env): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  };
  if (route === "own_licence") {
    return { ...base, CLAUDE_CODE_OAUTH_TOKEN: credential };
  }
  return { ...base, CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: env.AWS_REGION || "eu-west-2", AWS_BEARER_TOKEN_BEDROCK: credential };
}

/** The arguments of one request: the smallest turn Claude Code can be asked for, with no tools and nothing kept. */
export function checkArgs(launched: string): string[] {
  return [
    "-p",
    "--model",
    launched,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--system-prompt",
    "Reply with OK.",
    "Reply with OK."
  ];
}

/** `claude` itself rather than `hai`: hai adds `--plugin-dir` per plugin, and a plugin's hooks are what must not run. */
export const runClaude: CheckRunner = (args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    execFile("claude", args, { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const failure = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
      const timedOut = failure?.killed === true && failure.signal === "SIGKILL";
      const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : null;
      resolve({ code, timedOut, stdout: String(stdout), stderr: String(stderr || (failure && !timedOut ? failure.message : "")) });
    });
  });

export type CheckModelsOptions = {
  api: Pick<Api, "getCredential">;
  id: string;
  env?: Env;
  run?: CheckRunner;
  fs?: Pick<typeof nodeFs, "mkdtempSync" | "rmSync">;
  tmpRoot?: string;
  timeoutMs?: number;
  concurrency?: number;
  say?: (message: string) => void;
};

/**
 * Asks every catalogue model, `concurrency` at a time, and answers one result each. Null when there is no credential
 * to check with, which is a pod still waiting for its owner: nothing is reported, so the hub keeps what it had.
 *
 * Only a model and its status are ever said. The credential is in the child's environment and nowhere else — not in
 * its arguments, where `ps` would show it, and not in the log, which does not quote the child's output either.
 */
export async function checkModels({
  api,
  id,
  env = process.env,
  run = runClaude,
  fs = nodeFs,
  tmpRoot = os.tmpdir(),
  timeoutMs = CHECK_TIMEOUT_MS,
  concurrency = CHECK_CONCURRENCY,
  say = () => {}
}: CheckModelsOptions): Promise<ModelCheckResult[] | null> {
  const route = env.AGENT_HUB_MODEL_ROUTE === "own_licence" ? "own_licence" : "bedrock";
  const credential = await api.getCredential(id, route === "own_licence" ? "claude" : "bedrock");
  if (credential === null || credential === "") {
    say("model check: no credential stored yet; not checking");
    return null;
  }
  const results: ModelCheckResult[] = CHECKED_MODELS.map((model) => ({ model, status: "unknown" }));
  const asked = CHECKED_MODELS.flatMap((model, index) => {
    const launched = launcherModel(model, env);
    if (launched === null) {
      results[index] = { model, status: "unavailable" };
      return [];
    }
    return [{ index, model, launched }];
  });
  let next = 0;
  const worker = async () => {
    for (let item = asked[next++]; item !== undefined; item = asked[next++]) {
      const dir = fs.mkdtempSync(path.join(tmpRoot, "agent-hub-model-check-"));
      try {
        const outcome = await run(checkArgs(item.launched), { cwd: dir, env: checkEnv(route, credential, dir, env), timeoutMs });
        results[item.index] = { model: item.model, status: classify(outcome) };
      } catch {
        results[item.index] = { model: item.model, status: "unknown" };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, asked.length)) }, worker));
  say(`model check: ${results.map((r) => `${r.model} ${r.status}`).join(", ")}`);
  return results;
}

export type ModelChecker = {
  /** Asks for a check: one starts now, or follows the one running. Never throws. */
  request: () => Promise<void>;
};

/**
 * One check at a time, however many things ask for one, and at most one more queued behind it: a credential replaced
 * twice while a check runs needs one check after it, not two.
 */
export function createModelChecker({ api, ...options }: CheckModelsOptions & { api: Pick<Api, "getCredential" | "postModels"> }): ModelChecker {
  const say = options.say ?? (() => {});
  let running: Promise<void> | null = null;
  let again = false;
  const once = async () => {
    try {
      const results = await checkModels({ api, ...options });
      if (results !== null) {
        await api.postModels(options.id, { models: results });
      }
    } catch (e) {
      say(`model check failed: ${(e as Error).message}`);
    }
  };
  const loop = async () => {
    do {
      again = false;
      await once();
    } while (again);
    running = null;
  };
  return {
    request: () => {
      if (running !== null) {
        again = true;
        return running;
      }
      running = loop();
      return running;
    }
  };
}
