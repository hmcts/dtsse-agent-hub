// `agent-hub github export`: everything an HMCTS Assistant conversation's session does to turn its document into a
// GitHub issue, as one command, for a person whose ticket tool is GitHub. It mirrors `jira export`: the session runs
// it, so the issue is opened with the owner's own gh sign-in and they are its author, and one command saves a model
// turn per step. gh is signed in on every pod, since the pod clones the workspace with it, so unlike twg there is no
// sign-in to relay. See "GitHub export" under Conversations in dtsse-agent-hub's docs/agent-api.md.
import fs from "node:fs";
import path from "node:path";
import type { Api } from "./api.ts";
import type { Env } from "./env.ts";
import { withRetry } from "./retry.ts";
import { hubHome, readJson, writeJson } from "./session.ts";
import { claimExport, releaseExport } from "./twg-export.ts";
import { type RunResult, stripAnsi } from "./virtual/process.ts";
import type { Artefact, GithubExportReport } from "./wire.ts";

export const GITHUB_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
export const MAX_GITHUB_ERROR = 300;
// GitHub refuses an issue title over 256 characters.
export const MAX_TITLE = 256;
const FALLBACK_TITLE = "HMCTS Assistant document";
// Long enough for a slow GitHub, short enough that a hung gh is reported well inside the hub's 15-minute timeout.
const CREATE_TIMEOUT_MS = 120000;

export type GithubExportRequest = {
  exportId: string;
  repo: string;
};

export type GithubExportDeps = {
  api: Pick<Api, "getArtefact" | "putGithubExport">;
  agentId: string;
  env: Env;
  run: (cmd: string, args: string[], opts: { env: Env; timeoutMs: number }) => Promise<RunResult>;
  print: (message: string) => void;
  /** Where created issues are remembered; `hubHome()/github-exports` unless a test says otherwise. */
  dir?: string;
};

export type GithubExportOutcome = { number: number; url: string; again: boolean } | { error: string };

export function githubExportsDir(): string {
  return path.join(hubHome(), "github-exports");
}

export function githubIssueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

// The number is remembered before it is reported, so a report that fails cannot lead to a second issue: running the
// command again reports the remembered number instead.
function rememberedNumber(dir: string, exportId: string): number | null {
  const number = (readJson(path.join(dir, `${exportId}.json`)) as { number?: unknown } | null)?.number;
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : null;
}

function rememberNumber(dir: string, exportId: string, number: number): void {
  writeJson(path.join(dir, `${exportId}.json`), { number, created_at: new Date().toISOString() });
}

/** One line of issue title: the document's title, else its first heading, else a plain fallback. */
export function githubTitle(doc: Pick<Artefact, "title" | "markdown">): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(doc.markdown)?.[1];
  const raw = doc.title?.trim() || heading?.trim() || FALLBACK_TITLE;
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/**
 * The issue number in what `gh issue create` prints, which is the new issue's URL on its last line. Only a URL in the
 * repository asked for counts, so nothing else gh says can be taken for the issue. Null when there is none.
 */
export function parseCreatedNumber(stdout: string, repo: string): number | null {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`https://github\\.com/${escaped}/issues/(\\d{1,9})\\s*$`, "i").exec(stdout.trim());
  return match ? Number(match[1]) : null;
}

/** Why gh failed, in one line the person can read: the first line it wrote, at most `MAX_GITHUB_ERROR` characters. */
export function ghFailure(result: RunResult): string {
  if (result.code === 127) {
    return "gh is not installed here, so the issue could not be created.";
  }
  const line =
    stripAnsi(`${result.stderr}\n${result.stdout}`)
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text !== "") ?? "";
  const said = line ? `GitHub refused the issue: ${line}` : "GitHub refused the issue";
  return said.length > MAX_GITHUB_ERROR ? `${said.slice(0, MAX_GITHUB_ERROR - 1)}…` : said;
}

async function create(deps: GithubExportDeps, dir: string, request: GithubExportRequest): Promise<GithubExportOutcome> {
  const doc = await withRetry(() => deps.api.getArtefact(deps.agentId), { attempts: 3 });
  if (!doc.markdown.trim()) {
    return { error: "The document is empty, so there was nothing to export." };
  }
  // The body goes through a file rather than an argument: a long document would pass the argument limit, and gh reads
  // `--body-file` as it stands. Every other value is its own argv entry and no shell is involved, so nothing in the
  // title or the document is ever read as a command; `--name=value` keeps a value starting "-" from reading as a flag.
  const bodyFile = path.join(dir, `${request.exportId}.md`);
  fs.writeFileSync(bodyFile, doc.markdown, { mode: 0o600 });
  try {
    const args = ["issue", "create", `--repo=${request.repo}`, `--title=${githubTitle(doc)}`, `--body-file=${bodyFile}`];
    const result = await deps.run("gh", args, { env: deps.env, timeoutMs: CREATE_TIMEOUT_MS });
    if (result.code !== 0) {
      return { error: ghFailure(result) };
    }
    const number = parseCreatedNumber(result.stdout, request.repo);
    return number
      ? { number, url: githubIssueUrl(request.repo, number), again: false }
      : { error: "gh answered without an issue link, so the issue may or may not exist. Check the repository before exporting again." };
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

/**
 * Creates the issue for one export, once, and reports the outcome to the hub. A number already created for this
 * export id is reported again instead. Throws only when the hub cannot be told, so the session can run it again.
 */
export async function runGithubExport(deps: GithubExportDeps, request: GithubExportRequest): Promise<GithubExportOutcome> {
  const dir = deps.dir ?? githubExportsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let outcome: GithubExportOutcome;
  const known = rememberedNumber(dir, request.exportId);
  if (known) {
    outcome = { number: known, url: githubIssueUrl(request.repo, known), again: true };
  } else {
    if (!claimExport(dir, request.exportId)) {
      throw new Error(`export ${request.exportId} is already running in another command; wait for that one rather than starting another`);
    }
    try {
      outcome = await create(deps, dir, request);
      if ("number" in outcome) {
        rememberNumber(dir, request.exportId, outcome.number);
      }
    } finally {
      releaseExport(dir, request.exportId);
    }
  }
  const report: GithubExportReport =
    "number" in outcome ? { export_id: request.exportId, number: outcome.number } : { export_id: request.exportId, error: outcome.error };
  await withRetry(() => deps.api.putGithubExport(deps.agentId, report), { attempts: 3 });
  return outcome;
}
