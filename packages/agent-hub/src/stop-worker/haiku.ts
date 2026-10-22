// The summariser authenticates the way its session does: the owner's Claude licence (OAuth), or the Bedrock or API-key
// environment it inherits. It runs as a plain text completion: no tools, MCP servers, skills or session file, and
// disableAllHooks so no hook can recurse into agent-hub or start other work. runHaiku starts it in summariserCwd(), a
// private directory outside the workspace, so the workspace CLAUDE.md, auto-memory and project settings never load
// (about 3k input tokens instead of 21k). Claude Code keeps only the last --settings, so one JSON carries
// disableAllHooks, the credential helpers from the workspace's .claude/settings.json and settings.local.json, and
// AGENT_HUB_CLAUDE_SETTINGS (a path relative to the workspace root, or inline JSON), later ones winning. Each helper
// is a shell command, so it is prefixed with a cd to the workspace root and relative paths in it keep working.
// It never uses --bare: that ignores OAuth, so it would fail for everyone on their own Claude licence.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Env } from "../env.ts";
import { hubHome, projectDir } from "../session.ts";

const HAIKU_TIMEOUT_MS = 120000;

const HELPER_KEYS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper"];

type Settings = Record<string, unknown>;

function settingsObject(text: string): Settings {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readSettingsFile(file: string): Settings {
  try {
    return settingsObject(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function rootedHelpers(settings: Settings, root: string): Settings {
  const out: Settings = {};
  for (const key of HELPER_KEYS) {
    const helper = settings[key];
    if (typeof helper === "string" && helper.trim()) {
      out[key] = `cd '${root.replaceAll("'", "'\\''")}' && ${helper}`;
    }
  }
  return out;
}

/** The one `--settings` JSON the summariser is given: the workspace's helpers, any extra, and hooks off. */
export function summariserSettings(env: Env = process.env, root: string = projectDir()): string {
  const pick = (s: Settings): Settings => Object.fromEntries(HELPER_KEYS.filter((k) => k in s).map((k) => [k, s[k]]));
  const project = pick(readSettingsFile(path.join(root, ".claude", "settings.json")));
  const local = pick(readSettingsFile(path.join(root, ".claude", "settings.local.json")));
  const given = (env.AGENT_HUB_CLAUDE_SETTINGS || "").trim();
  // An unreadable AGENT_HUB_CLAUDE_SETTINGS is dropped; it must not switch the hooks back on.
  const extra = !given ? {} : given.startsWith("{") ? settingsObject(given) : readSettingsFile(path.resolve(root, given));
  const merged = { ...project, ...local, ...extra };
  return JSON.stringify({ ...merged, ...rootedHelpers(merged, root), disableAllHooks: true });
}

// One fixed directory, not a fresh one per call: Claude Code creates ~/.claude/projects/<cwd>/ for every working
// directory it runs in. It sits in the agent-hub state directory, so it is private to the user, and CLAUDE.md files
// found walking up from it are the user's own.
export function summariserCwd(): string {
  const dir = path.join(hubHome(), "summariser-cwd");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export type HaikuCommand = {
  bin: string;
  args: string[];
};

export function haikuCommand(env: Env = process.env, root: string = projectDir()): HaikuCommand {
  const bin = env.AGENT_HUB_CLAUDE_BIN || "claude";
  const args = [
    "-p",
    "--model",
    "haiku",
    "--settings",
    summariserSettings(env, root),
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json"
  ];
  return { bin, args };
}

export type RunHaikuOptions = {
  env?: Env;
  root?: string;
};

/** The summariser's one model call. Resolves with the raw stdout for `parseHaikuResult`. */
export function runHaiku(prompt: string, { env = process.env, root = projectDir() }: RunHaikuOptions = {}): Promise<string> {
  const { bin, args } = haikuCommand(env, root);
  // KNOWLEDGE_SWEEP_CHILD is the workspace's own marker; the summariser is a child for both, so neither
  // recurses into this session.
  const childEnv: NodeJS.ProcessEnv = { ...env, AGENT_HUB_CHILD: "1", KNOWLEDGE_SWEEP_CHILD: "1" };
  delete childEnv.CLAUDE_CODE_MESSAGING_SOCKET;
  delete childEnv.CLAUDE_CODE_MESSAGING_TOKEN;
  delete childEnv.CLAUDE_CODE_SESSION_ID;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args, prompt], { cwd: summariserCwd(), env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), HAIKU_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`${bin} exited ${code ?? signal}: ${err.trim().slice(0, 300)}`));
      }
    });
  });
}
