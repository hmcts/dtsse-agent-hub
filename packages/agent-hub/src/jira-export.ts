// `agent-hub jira export`: everything an HMCTS Assistant conversation's session does to turn its document into a
// Jira ticket, as one command. The session still runs it, so the ticket is made with the owner's own twg sign-in and
// they are its reporter; what this saves is a model turn per step. Each step the session runs as its own tool call
// is another round trip to the model, which is far slower than the twg and hub calls it wraps. See
// "Jira export" under Conversations in dtsse-agent-hub's docs/agent-api.md.
import fs from "node:fs";
import path from "node:path";
import type { Api, Artefact, JiraExportReport } from "./api.ts";
import type { Env } from "./env.ts";
import { withRetry } from "./retry.ts";
import { hubHome, readJson, writeJson } from "./session.ts";
import type { AtlassianLoginResult } from "./virtual/atlassian.ts";
import { type RunResult, stripAnsi } from "./virtual/sign-in.ts";

export const EXPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-\d{1,9}$/;
export const MAX_JIRA_ERROR = 300;
// twg signs in to the hmcts site, so every ticket it makes is here.
export const JIRA_BROWSE_URL = "https://hmcts.atlassian.net/browse/";
// Jira refuses a summary over 255 characters.
export const MAX_SUMMARY = 255;
const FALLBACK_SUMMARY = "HMCTS Assistant document";
// Long enough for a slow Jira, short enough that a hung twg is reported well inside the hub's 15-minute timeout.
const CREATE_TIMEOUT_MS = 120000;
const WHOAMI_TIMEOUT_MS = 30000;
// The hub's export timeout: a lock older than this belongs to an export the hub has already given up on.
const LOCK_STALE_MS = 15 * 60_000;

export type JiraExportRequest = {
  exportId: string;
  project: string;
  issueType: string;
  labels: string[];
};

export type JiraExportDeps = {
  api: Pick<Api, "getArtefact" | "putJiraExport">;
  agentId: string;
  env: Env;
  run: (cmd: string, args: string[], opts: { env: Env; timeoutMs: number }) => Promise<RunResult>;
  /** Signs twg in, relaying a device code to the owner; null outside a pod, where there is nobody to relay it to. */
  login: (() => Promise<AtlassianLoginResult>) | null;
  print: (message: string) => void;
  /** Where created keys are remembered; `hubHome()/jira-exports` unless a test says otherwise. */
  dir?: string;
};

export type JiraExportOutcome = { key: string; again: boolean } | { error: string };

export function jiraExportsDir(): string {
  return path.join(hubHome(), "jira-exports");
}

// The key is remembered before it is reported, so a report that fails cannot lead to a second ticket: running the
// command again reports the remembered key instead.
function rememberedKey(dir: string, exportId: string): string | null {
  const key = (readJson(path.join(dir, `${exportId}.json`)) as { key?: unknown } | null)?.key;
  return typeof key === "string" && JIRA_KEY_RE.test(key) ? key : null;
}

function rememberKey(dir: string, exportId: string, key: string): void {
  writeJson(path.join(dir, `${exportId}.json`), { key, created_at: new Date().toISOString() });
}

/**
 * Claims the export for this process, so two messages delivered while it is pending cannot each run twg. False when
 * another live command holds it; a lock older than the hub's timeout is taken over.
 */
function claim(dir: string, exportId: string): boolean {
  const lock = path.join(dir, `${exportId}.lock`);
  try {
    fs.closeSync(fs.openSync(lock, "wx", 0o600));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw e;
    }
  }
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs <= LOCK_STALE_MS) {
      return false;
    }
  } catch {}
  fs.writeFileSync(lock, "", { mode: 0o600 });
  return true;
}

/** One line of Jira summary: the document's title, else its first heading, else a plain fallback. */
export function jiraSummary(doc: Pick<Artefact, "title" | "markdown">): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(doc.markdown)?.[1];
  const raw = doc.title?.trim() || heading?.trim() || FALLBACK_SUMMARY;
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}

/**
 * The issue key in `twg jira workitem create --output=json`: a `key` field somewhere under `data`, preferring one in
 * the project asked for, since a created issue's JSON can also name its parent or project. Null when there is none.
 */
export function parseCreatedKey(stdout: string, project: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const root = (parsed as { data?: unknown } | null)?.data ?? parsed;
  const found: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, depth + 1);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.key === "string" && JIRA_KEY_RE.test(record.key)) {
      found.push(record.key);
    }
    for (const child of Object.values(record)) {
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return found.find((key) => key.startsWith(`${project}-`)) ?? found[0] ?? null;
}

/** Why twg failed, in one line the person can read: its JSON error message when it gave one, else stderr's first line. */
export function twgFailure(result: RunResult): string {
  let message: unknown;
  try {
    const parsed = JSON.parse(result.stdout) as { error?: { message?: unknown } | string; message?: unknown } | null;
    message = typeof parsed?.error === "string" ? parsed.error : (parsed?.error?.message ?? parsed?.message);
  } catch {}
  const line =
    (typeof message === "string" && message.trim()) ||
    stripAnsi(`${result.stderr}\n${result.stdout}`)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "");
  const why = line ? `Jira refused the ticket: ${line}` : `twg exited ${result.code} without saying why.`;
  return why.length > MAX_JIRA_ERROR ? `${why.slice(0, MAX_JIRA_ERROR - 1)}…` : why;
}

async function signedIn(deps: JiraExportDeps): Promise<string | null> {
  const whoami = await deps.run("twg", ["whoami"], { env: deps.env, timeoutMs: WHOAMI_TIMEOUT_MS });
  if (whoami.code === 0) {
    return null;
  }
  if (whoami.code === 127) {
    return "twg is not installed here, so the ticket could not be created.";
  }
  if (!deps.login) {
    return "twg is not signed in to Atlassian, so the ticket could not be created.";
  }
  deps.print("agent-hub: twg is not signed in; asking the user to sign in to Atlassian");
  return (await deps.login()) === "not-signed-in" ? "The Atlassian sign-in was not completed, so the ticket could not be created." : null;
}

async function create(deps: JiraExportDeps, request: JiraExportRequest): Promise<JiraExportOutcome> {
  // The document first: it is one quick request, and an empty one should not ask anybody to sign in.
  const doc = await withRetry(() => deps.api.getArtefact(deps.agentId), { attempts: 3 });
  if (!doc.markdown.trim()) {
    return { error: "The document is empty, so there was nothing to export." };
  }
  const notSignedIn = await signedIn(deps);
  if (notSignedIn) {
    return { error: notSignedIn };
  }
  // Every value is its own argv entry and no shell is involved, so nothing in the title or the document is ever
  // read as a command. `--name=value` keeps a value that starts with "-" from reading as a flag.
  const args = [
    "jira",
    "workitem",
    "create",
    `--space=${request.project}`,
    `--type=${request.issueType}`,
    `--summary=${jiraSummary(doc)}`,
    `--description=${doc.markdown}`,
    "--description-format=markdown",
    ...(request.labels.length ? [`--labels=${request.labels.join(",")}`] : []),
    "--output=json",
    "--output-summary=none"
  ];
  const result = await deps.run("twg", args, { env: deps.env, timeoutMs: CREATE_TIMEOUT_MS });
  if (result.code !== 0) {
    return { error: twgFailure(result) };
  }
  const key = parseCreatedKey(result.stdout, request.project);
  return key
    ? { key, again: false }
    : { error: "twg answered without an issue key, so the ticket may or may not exist. Check the backlog before exporting again." };
}

/**
 * Creates the ticket for one export, once, and reports the outcome to the hub. A key already created for this
 * export id is reported again instead. Throws only when the hub cannot be told, so the session can run it again.
 */
export async function runJiraExport(deps: JiraExportDeps, request: JiraExportRequest): Promise<JiraExportOutcome> {
  const dir = deps.dir ?? jiraExportsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let outcome: JiraExportOutcome;
  const known = rememberedKey(dir, request.exportId);
  if (known) {
    outcome = { key: known, again: true };
  } else {
    if (!claim(dir, request.exportId)) {
      throw new Error(`export ${request.exportId} is already running in another command; wait for that one rather than starting another`);
    }
    try {
      outcome = await create(deps, request);
      if ("key" in outcome) {
        rememberKey(dir, request.exportId, outcome.key);
      }
    } finally {
      fs.rmSync(path.join(dir, `${request.exportId}.lock`), { force: true });
    }
  }
  const report: JiraExportReport = "key" in outcome ? { export_id: request.exportId, key: outcome.key } : { export_id: request.exportId, error: outcome.error };
  await withRetry(() => deps.api.putJiraExport(deps.agentId, report), { attempts: 3 });
  return outcome;
}
