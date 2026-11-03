// `agent-hub github export`: everything a CFT Workspace conversation's session does to turn its document into a
// GitHub issue, as one command, for a person whose ticket tool is GitHub. It mirrors `jira export`: the session runs
// it, so the issue is opened with the owner's own gh sign-in and they are its author, and one command saves a model
// turn per step. gh is signed in on every pod, since the pod clones the workspace with it, so unlike twg there is no
// sign-in to relay. When the person chose a Project as well, the issue is added to that board once it exists: an issue
// lives in a repository, and a Project only shows it. See "GitHub export" under Conversations in dtsse-agent-hub's
// docs/agent-api.md.
import fs from "node:fs";
import path from "node:path";
import type { Api } from "./api.ts";
import { missingScope } from "./assistant/github-lookups.ts";
import type { Env } from "./env.ts";
import { ghSaid } from "./github.ts";
import { withRetry } from "./retry.ts";
import { hubHome, readJson, writeJson } from "./session.ts";
import { claimExport, releaseExport } from "./twg-export.ts";
import type { RunResult } from "./virtual/process.ts";
import type { Artefact, GithubExportReport } from "./wire.ts";

export const MAX_GITHUB_ERROR = 300;
// GitHub refuses an issue title over 256 characters.
export const MAX_TITLE = 256;
const FALLBACK_TITLE = "CFT Workspace document";
// Long enough for a slow GitHub, short enough that a hung gh is reported well inside the hub's 15-minute timeout.
const CREATE_TIMEOUT_MS = 120000;
// Each step after the issue exists: labelling it and putting it on a Project. Shorter than the create, so that every
// step at its limit still ends inside the Bash timeout the session is given (`GITHUB_EXPORT_BASH_TIMEOUT_MS`), with
// the report made: the document read and the report are quick, and a label step is one call per label plus one.
export const STEP_TIMEOUT_MS = 30000;

/** A Project as `owner` and `number`, which is how gh names one. */
export type GithubProject = { owner: string; number: number };

export type GithubExportRequest = {
  exportId: string;
  repo: string;
  project?: GithubProject | null;
  /** What to label the issue, as the Jira ticket is labelled. */
  labels?: string[];
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

/**
 * `projectError` is set when the issue was made but could not be put on the Project asked for, and `labelError` when
 * it could not be labelled. Only the first is reported: a missing label is said to the session, which tells the person.
 */
export type GithubExportOutcome = { number: number; url: string; again: boolean; projectError?: string; labelError?: string } | { error: string };

export function githubExportsDir(): string {
  return path.join(hubHome(), "github-exports");
}

export function githubIssueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

// The number is remembered before it is reported, so a report that fails cannot lead to a second issue: running the
// command again reports the remembered number instead, with what came of adding it to the Project.
function remembered(dir: string, exportId: string): { number: number; projectError?: string } | null {
  const saved = readJson(path.join(dir, `${exportId}.json`)) as { number?: unknown; project_error?: unknown } | null;
  const number = saved?.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    return null;
  }
  return typeof saved?.project_error === "string" ? { number, projectError: saved.project_error } : { number };
}

function remember(dir: string, exportId: string, number: number, projectError?: string): void {
  writeJson(path.join(dir, `${exportId}.json`), { number, ...(projectError ? { project_error: projectError } : {}), created_at: new Date().toISOString() });
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
  return ghSaid(result, "GitHub refused the issue", MAX_GITHUB_ERROR);
}

/** Why the issue could not be put on the Project, in one line, or null once it is on it. */
async function addToProject(deps: GithubExportDeps, project: GithubProject, url: string): Promise<string | null> {
  const args = ["project", "item-add", String(project.number), `--owner=${project.owner}`, `--url=${url}`];
  const result = await deps.run("gh", args, { env: deps.env, timeoutMs: STEP_TIMEOUT_MS });
  if (result.code === 0) {
    return null;
  }
  if (missingScope(result) || /project scope|read:project|required scopes/i.test(`${result.stderr}${result.stdout}`)) {
    return "your GitHub sign-in needs the project scope to add it to a Project. Reconnect GitHub in Connections";
  }
  return ghSaid(result, "GitHub would not add it to the Project", MAX_GITHUB_ERROR);
}

// GitHub's dark green, which reads on both its light and dark themes.
const LABEL_COLOUR = "1f883d";

/**
 * Labels the issue, creating any label the repository does not have yet: GitHub refuses an issue a label it has never
 * heard of. Done once the issue exists, so a person who may open issues but not label them still gets the issue, and
 * is told why it has no label. Null once it is labelled.
 */
async function label(deps: GithubExportDeps, repo: string, number: number, labels: readonly string[]): Promise<string | null> {
  for (const name of labels) {
    // Fails harmlessly when the label is there already, or the person cannot make labels, which the edit then says.
    await deps.run("gh", ["label", "create", name, `--repo=${repo}`, `--color=${LABEL_COLOUR}`, "--description=Made from the CFT Workspace"], {
      env: deps.env,
      timeoutMs: STEP_TIMEOUT_MS
    });
  }
  const result = await deps.run("gh", ["issue", "edit", String(number), `--repo=${repo}`, `--add-label=${labels.join(",")}`], {
    env: deps.env,
    timeoutMs: STEP_TIMEOUT_MS
  });
  return result.code === 0 ? null : ghSaid(result, `GitHub would not label it ${labels.join(", ")}`, MAX_GITHUB_ERROR);
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
    if (!number) {
      return { error: "gh answered without an issue link, so the issue may or may not exist. Check the repository before exporting again." };
    }
    const url = githubIssueUrl(request.repo, number);
    // Remembered before the Project is tried, so a failure there, or a crash, cannot lead to a second issue.
    remember(dir, request.exportId, number);
    const labelError = request.labels?.length ? await label(deps, request.repo, number, request.labels) : null;
    const projectError = request.project ? await addToProject(deps, request.project, url) : null;
    return {
      number,
      url,
      again: false,
      ...(projectError === null ? {} : { projectError }),
      ...(labelError === null ? {} : { labelError })
    };
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
  const known = remembered(dir, request.exportId);
  if (known) {
    outcome = { ...known, url: githubIssueUrl(request.repo, known.number), again: true };
  } else {
    if (!claimExport(dir, request.exportId)) {
      throw new Error(`export ${request.exportId} is already running in another command; wait for that one rather than starting another`);
    }
    try {
      outcome = await create(deps, dir, request);
      if ("number" in outcome) {
        remember(dir, request.exportId, outcome.number, outcome.projectError);
      }
    } finally {
      releaseExport(dir, request.exportId);
    }
  }
  let report: GithubExportReport;
  if ("number" in outcome) {
    report = { export_id: request.exportId, number: outcome.number, ...(outcome.projectError ? { project_error: outcome.projectError } : {}) };
  } else {
    report = { export_id: request.exportId, error: outcome.error };
  }
  await withRetry(() => deps.api.putGithubExport(deps.agentId, report), { attempts: 3 });
  return outcome;
}
