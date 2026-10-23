// The pod's half of the HMCTS Assistant's Jira export: create a conversation's document as an issue with the owner's
// own twg sign-in, so they are its reporter, and report the key. See "Jira export" under Conversations in
// dtsse-agent-hub's docs/agent-api.md.
import nodeFs from "node:fs";
import path from "node:path";
import type { Api, JiraExportReport } from "../api.ts";
import type { Env } from "../env.ts";
import { hubHome } from "../session.ts";
import type { AtlassianLoginResult } from "../virtual/atlassian.ts";
import { type RunResult, stripAnsi } from "../virtual/sign-in.ts";

/** A `jira_export` on the sessions stream. */
export type JiraExport = {
  conversation_id: string;
  export_id: string;
  project: string;
  issue_type: string;
  labels: string[];
  summary: string;
  description: string;
};

// Jira's own limits: a summary is at most 255 characters and a description at most 32,767.
export const MAX_SUMMARY = 255;
export const MAX_DESCRIPTION = 32767;
// The hub's limit on a reported error.
const MAX_ERROR = 300;
// Exports remembered, so a repeated `export_id` reports the issue already created rather than making another.
const REMEMBERED = 100;
const TWG_TIMEOUT_MS = 90000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
const LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;

const stateFile = () => path.join(hubHome(), "virtual", "jira-exports.json");

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The export, or null for anything the hub would not have sent. */
export function parseJiraExport(value: unknown): JiraExport | null {
  const raw = asRecord(value);
  if (
    !raw ||
    !UUID_RE.test(String(raw.conversation_id)) ||
    !UUID_RE.test(String(raw.export_id)) ||
    !PROJECT_RE.test(String(raw.project)) ||
    typeof raw.issue_type !== "string" ||
    raw.issue_type.trim() === "" ||
    typeof raw.summary !== "string" ||
    typeof raw.description !== "string" ||
    !Array.isArray(raw.labels) ||
    !raw.labels.every((label) => typeof label === "string" && LABEL_RE.test(label))
  ) {
    return null;
  }
  return {
    conversation_id: raw.conversation_id as string,
    export_id: raw.export_id as string,
    project: raw.project as string,
    issue_type: raw.issue_type,
    labels: raw.labels as string[],
    summary: raw.summary,
    description: raw.description
  };
}

/**
 * `twg jira workitem create` for the export. Each value is joined to its flag with `=`, so a summary that starts
 * with a dash is not taken for a flag, and nothing passes through a shell.
 */
export function twgCreateArgs(request: JiraExport): string[] {
  const summary = request.summary.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY) || "Untitled document";
  return [
    "jira",
    "workitem",
    "create",
    `--space=${request.project}`,
    `--type=${request.issue_type}`,
    `--summary=${summary}`,
    ...(request.description.trim() === "" ? [] : [`--description=${request.description}`, "--description-format=markdown"]),
    ...(request.labels.length === 0 ? [] : [`--labels=${request.labels.join(",")}`]),
    "--output=json",
    "--output-summary=none"
  ];
}

/** The key of the issue twg created in `project`, from its JSON output, or null when it names none. */
export function issueKey(stdout: string, project: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const wanted = new RegExp(`^${project}-[0-9]{1,9}$`);
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const next = pending.shift();
    if (Array.isArray(next)) {
      pending.push(...next);
    } else {
      const record = asRecord(next);
      if (record) {
        if (typeof record.key === "string" && wanted.test(record.key)) {
          return record.key;
        }
        pending.push(...Object.values(record));
      }
    }
  }
  return null;
}

/** Why twg failed, short enough for the hub and plain enough for the person: its message, not its stack. */
export function twgError(result: RunResult): string {
  for (const text of [result.stdout, result.stderr]) {
    try {
      const raw = asRecord(JSON.parse(text));
      const error = asRecord(raw?.error);
      const message = typeof error?.message === "string" ? error.message : typeof raw?.message === "string" ? raw.message : null;
      if (message) {
        return `Jira refused the ticket: ${message}`.slice(0, MAX_ERROR);
      }
    } catch {}
  }
  const line = stripAnsi(`${result.stderr}\n${result.stdout}`)
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  return (line ? `Jira refused the ticket: ${line}` : `twg exited ${result.code} without saying why`).slice(0, MAX_ERROR);
}

export type JiraExporterFs = Pick<typeof nodeFs, "readFileSync" | "writeFileSync" | "mkdirSync" | "renameSync">;

export type CreateJiraExporterOptions = {
  api: Pick<Api, "putJiraExport" | "virtualStatus">;
  id: string;
  env?: Env;
  /** Runs twg; a test passes its own. */
  exec: (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<RunResult>;
  /** Whether twg has a sign-in in this pod. */
  signedIn: () => boolean;
  /** The Atlassian sign-in the pod runs at boot, which relays a device code to the owner. */
  login: () => Promise<AtlassianLoginResult>;
  fs?: JiraExporterFs;
  say?: (message: string) => void;
};

export type JiraExporter = {
  /** Handles one `jira_export`, after any still running: two at once would race for the sign-in. */
  export: (data: unknown) => Promise<void>;
};

export function createJiraExporter({ api, id, exec, signedIn, login, fs = nodeFs, say = () => {} }: CreateJiraExporterOptions): JiraExporter {
  const created = load();
  let chain: Promise<void> = Promise.resolve();

  function load(): Map<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8")) as unknown;
      const entries = Array.isArray(raw) ? raw : [];
      return new Map(
        entries.flatMap((entry) => {
          const record = asRecord(entry);
          return record && typeof record.export_id === "string" && typeof record.key === "string" ? [[record.export_id, record.key] as const] : [];
        })
      );
    } catch {
      return new Map();
    }
  }

  function remember(exportId: string, key: string): void {
    created.set(exportId, key);
    while (created.size > REMEMBERED) {
      const oldest = created.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      created.delete(oldest);
    }
    const file = stateFile();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const kept = [...created].map(([export_id, issue]) => ({ export_id, key: issue }));
      fs.writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      say(`could not save ${file}: ${(e as Error).message}`);
    }
  }

  async function report(request: JiraExport, body: JiraExportReport): Promise<void> {
    await api.putJiraExport(id, request.conversation_id, body);
    say("key" in body ? `jira: ${request.conversation_id} exported as ${body.key}` : `jira: ${request.conversation_id} not exported: ${body.error}`);
  }

  /** A sign-in if twg has none. Relaying its code moves the agent to `awaiting_login`, so it is put back after. */
  async function ensureSignedIn(): Promise<boolean> {
    if (signedIn()) {
      return true;
    }
    say("jira: no twg sign-in; asking the owner to sign in to Atlassian");
    const result = await login();
    if (result !== "restored") {
      await api.virtualStatus(id, "running");
    }
    return result !== "not-signed-in";
  }

  async function one(data: unknown): Promise<void> {
    const request = parseJiraExport(data);
    if (!request) {
      say(`ignoring a jira_export the hub would not send: ${JSON.stringify(data).slice(0, 200)}`);
      return;
    }
    const already = created.get(request.export_id);
    if (already) {
      await report(request, { export_id: request.export_id, key: already });
      return;
    }
    if (request.description.length > MAX_DESCRIPTION) {
      const error = `Jira takes at most ${MAX_DESCRIPTION.toLocaleString("en-GB")} characters in a description; shorten the document and try again.`;
      await report(request, { export_id: request.export_id, error });
      return;
    }
    if (!(await ensureSignedIn())) {
      await report(request, { export_id: request.export_id, error: "The Atlassian sign-in was not finished, so no ticket was created. Try again." });
      return;
    }
    const result = await exec("twg", twgCreateArgs(request), { timeoutMs: TWG_TIMEOUT_MS });
    if (result.code !== 0) {
      await report(request, { export_id: request.export_id, error: twgError(result) });
      return;
    }
    const key = issueKey(result.stdout, request.project);
    if (!key) {
      await report(request, { export_id: request.export_id, error: "Jira did not say which ticket it created. Check the backlog before trying again." });
      return;
    }
    remember(request.export_id, key);
    await report(request, { export_id: request.export_id, key });
  }

  return {
    export: (data) => {
      chain = chain.then(() => one(data)).catch((e) => say(`jira_export failed: ${(e as Error).message}`));
      return chain;
    }
  };
}
