// The commands Claude Code's hooks and the processes they start run: the hook entry point, the per-session bridge,
// the auto-enable worker and the stop worker.
import { runBridge } from "../bridge.ts";
import { runAutoEnable } from "../enable.ts";
import { type HookPayload, mustDeny, runHook } from "../hooks.ts";
import { denyOutput, UNDELIVERED_REASON } from "../questions.ts";
import { ensureStateDir, log, requireSessionId, validSessionId } from "../session.ts";
import { runStopWorker } from "../stop-worker/index.ts";
import { type Command, parseFlags } from "./command.ts";

// Hooks never fail the session and never print unless adding context on purpose. The one exception is a
// `PreToolUse` that has to decide: see `mustDeny`.
export const hook: Command = async (cli, args) => {
  let input: HookPayload | null = {};
  try {
    const raw = cli.readStdin();
    input = raw.trim() ? (JSON.parse(raw) as HookPayload | null) : {};
    const out = await runHook(args[0] ?? "", input, cli.env);
    if (out && typeof out === "object") {
      cli.stdout.write(JSON.stringify(out));
    } else if (out) {
      cli.stdout.write(`${out}\n`);
    }
  } catch (e) {
    // Printing nothing here would be read as "no decision", so the prompt a pod cannot answer is drawn. This is
    // reached before `runHook` can decide for itself — a stdin body that is not JSON throws on the line above it,
    // so `parseQuestions` never sees the question — and the decision has to be made anyway.
    if (mustDeny(args[0] ?? "", input, cli.env)) {
      cli.stdout.write(JSON.stringify(denyOutput(UNDELIVERED_REASON)));
    }
    if (validSessionId(input?.session_id)) {
      log(input.session_id as string, `hook ${args[0]} failed: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    }
  }
  return 0;
};

export const bridge: Command = async (cli, argv) => {
  const { flags } = parseFlags(argv, ["session"]);
  const sid = flags.session || requireSessionId(cli.env);
  ensureStateDir(sid);
  await runBridge({ sid, env: cli.env });
  return 0;
};

export const autoEnable: Command = async (cli, argv) => {
  const { flags } = parseFlags(argv, ["session", "cwd"]);
  const sid = flags.session || requireSessionId(cli.env);
  ensureStateDir(sid);
  log(sid, "auto-enable: worker started");
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGINT", 130]
  ] as const) {
    process.once(signal, () => {
      log(sid, `auto-enable: killed by ${signal} before it finished`);
      process.exit(code);
    });
  }
  await runAutoEnable({ sid, cwd: flags.cwd, env: cli.env });
  return 0;
};

export const stopWorker: Command = async (cli, argv) => {
  const { flags } = parseFlags(argv, ["session", "transcript"]);
  const sid = flags.session || requireSessionId(cli.env);
  ensureStateDir(sid);
  await runStopWorker({ sid, transcriptPath: flags.transcript });
  return 0;
};
