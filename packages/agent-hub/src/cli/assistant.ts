// The commands an HMCTS Assistant conversation's session runs: its shared document, and the Jira and Confluence
// exports the person asked for.
import { ApiError } from "../api.ts";
import { CONFLUENCE_EXPORT_ID_RE, CONFLUENCE_ID_RE, MAX_CONFLUENCE_ERROR, MAX_PAGE_TITLE, runConfluenceExport } from "../confluence-export.ts";
import { CLI } from "../envelope.ts";
import { EXPORT_ID_RE, JIRA_BROWSE_URL, JIRA_KEY_RE, MAX_JIRA_ERROR, runJiraExport } from "../jira-export.ts";
import { requireSessionId } from "../session.ts";
import { atlassianLogin, run } from "../virtual/index.ts";
import { virtualAgent } from "../virtual-agent.ts";
import type { ArtefactBody, ConfluenceExportReport, JiraExportReport } from "../wire.ts";
import { type Cli, type Command, parseFlags, refuseSecrets, requireAgent, UsageError } from "./command.ts";

export const artefact: Command = async (cli, argv) => {
  const json = argv.includes("--json");
  const { flags, rest } = parseFlags(
    argv.filter((a) => a !== "--json"),
    ["title", "base"]
  );
  const [action, ...extra] = rest;
  if (action !== "get" && action !== "put") {
    throw new UsageError("artefact takes get or put");
  }
  if (extra.length) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
  if (action === "get" && (flags.title !== undefined || flags.base !== undefined)) {
    throw new UsageError("--title and --base go with artefact put");
  }
  if (action === "put" && json) {
    throw new UsageError("--json goes with artefact get");
  }
  if (flags.base !== undefined && !/^\d+$/.test(flags.base)) {
    throw new UsageError("--base must be a version number");
  }
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  // Only a conversation's agent has a document, so a 404 here is the session, not a missing agent.
  const notConversation = (e: unknown): never => {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error("this session is not an HMCTS Assistant conversation, so it has no document");
    }
    throw e;
  };

  if (action === "get") {
    const doc = await api.getArtefact(agent.agent_id).catch(notConversation);
    if (json) {
      cli.print(JSON.stringify(doc));
      return 0;
    }
    if (!doc.markdown) {
      cli.printError(`agent-hub: the conversation's document is empty (version ${doc.version})`);
      return 0;
    }
    cli.stdout.write(doc.markdown.endsWith("\n") ? doc.markdown : `${doc.markdown}\n`);
    return 0;
  }

  const markdown = cli.readStdin();
  if (!markdown.trim()) {
    throw new UsageError("artefact put reads the markdown from stdin, and it was empty");
  }
  refuseSecrets(`${flags.title ?? ""}\n${markdown}`);
  const base = flags.base !== undefined ? Number(flags.base) : (await api.getArtefact(agent.agent_id).catch(notConversation)).version;
  const body: ArtefactBody = { markdown, base_version: base };
  if (flags.title?.trim()) {
    body.title = flags.title.trim();
  }
  try {
    const res = await api.putArtefact(agent.agent_id, body);
    cli.print(`agent-hub: saved the conversation's document as version ${res.version}`);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 409)) {
      return notConversation(e);
    }
    const current = e.body?.current;
    const by = current?.updated_by ? `, last written by ${current.updated_by === "user" ? "the user" : "this conversation"}` : "";
    cli.printError(`agent-hub artefact: the document has changed since version ${base}: it is now version ${current?.version ?? "?"}${by}. Nothing was saved.`);
    cli.printError(
      `Read it with ${CLI} artefact get, merge your change into it, and put it again${current?.version !== undefined ? ` with --base ${current.version}` : ""}.`
    );
    return 1;
  }
  return 0;
};

const PROJECT_RE = /^[A-Z][A-Z0-9_]{1,9}$/;
const WORD_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Only a conversation's agent has a document and an export, so a 404 is the session, not a missing agent.
function noExport(label: string): (e: unknown) => never {
  return (e) => {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error(`this session is not an HMCTS Assistant conversation, so it has no ${label} export`);
    }
    throw e;
  };
}

type ExportStep = (cli: Cli, exportId: string, flags: Record<string, string>) => Promise<number>;

/** `jira` and `confluence`: each takes `export` or `report` and the export id, and each action has flags of its own. */
type ExportSpec = {
  exportIdRe: RegExp;
  exportFlags: readonly string[];
  reportFlags: readonly string[];
  export: ExportStep;
  report: ExportStep;
};

function exportCommand(kind: string, spec: ExportSpec): Command {
  return async (cli, argv) => {
    const { flags, rest } = parseFlags(argv, [...spec.reportFlags, ...spec.exportFlags]);
    const [action, exportId, ...extra] = rest;
    if (action !== "report" && action !== "export") {
      throw new UsageError(`${kind} takes export or report`);
    }
    if (!exportId || !spec.exportIdRe.test(exportId)) {
      throw new UsageError(`${kind} ${action} needs the export id it was asked under`);
    }
    if (extra.length) {
      throw new UsageError(`unexpected argument: ${extra[0]}`);
    }
    const others = action === "report" ? spec.exportFlags : spec.reportFlags;
    const stray = others.find((name) => flags[name] !== undefined);
    if (stray) {
      throw new UsageError(`--${stray} does not go with ${kind} ${action}`);
    }
    return action === "report" ? spec.report(cli, exportId, flags) : spec.export(cli, exportId, flags);
  };
}

const jiraReport: ExportStep = async (cli, exportId, flags) => {
  if ((flags.key === undefined) === (flags.error === undefined)) {
    throw new UsageError("jira report takes one of --key or --error");
  }
  if (flags.key !== undefined && !JIRA_KEY_RE.test(flags.key)) {
    throw new UsageError(`--key must be an issue key such as VIBE-123, not ${flags.key}`);
  }
  const error = flags.error?.trim();
  if (error === "") {
    throw new UsageError("--error needs a reason");
  }
  const agent = requireAgent(requireSessionId(cli.env));
  const body: JiraExportReport =
    flags.key !== undefined ? { export_id: exportId, key: flags.key } : { export_id: exportId, error: (error ?? "").slice(0, MAX_JIRA_ERROR) };
  await cli.api().putJiraExport(agent.agent_id, body).catch(noExport("Jira"));
  cli.print(flags.key !== undefined ? `agent-hub: reported ${flags.key} for export ${exportId}` : `agent-hub: reported export ${exportId} as failed`);
  return 0;
};

// The whole export as one command, so the session spends one tool call on it rather than one per step.
const jiraExport: ExportStep = async (cli, exportId, flags) => {
  const project = flags.project ?? "";
  const issueType = flags.type ?? "";
  const labels = flags.labels ? flags.labels.split(",") : [];
  if (!PROJECT_RE.test(project)) {
    throw new UsageError("jira export needs --project, a Jira project key such as VIBE");
  }
  if (!WORD_RE.test(issueType)) {
    throw new UsageError("jira export needs --type, an issue type such as Story");
  }
  if (!labels.every((label) => WORD_RE.test(label))) {
    throw new UsageError("--labels must be comma-separated words");
  }
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  const outcome = await runJiraExport(
    {
      api,
      agentId: agent.agent_id,
      env: cli.env,
      run,
      login: virtualAgent(cli.env) ? () => atlassianLogin({ api, env: cli.env }) : null,
      print: cli.print
    },
    { exportId, project, issueType, labels }
  ).catch(noExport("Jira"));
  if ("error" in outcome) {
    cli.print(`agent-hub: no ticket was created for export ${exportId}: ${outcome.error} The user has been shown this.`);
    return 1;
  }
  cli.print(
    `agent-hub: ${outcome.again ? "already created" : "created"} ${outcome.key} for export ${exportId} and reported it; the user's Assistant shows a link to ${JIRA_BROWSE_URL}${outcome.key}`
  );
  return 0;
};

const confluenceReport: ExportStep = async (cli, exportId, flags) => {
  if ((flags["page-id"] === undefined) === (flags.error === undefined)) {
    throw new UsageError("confluence report takes one of --page-id or --error");
  }
  if (flags["page-id"] !== undefined && !CONFLUENCE_ID_RE.test(flags["page-id"])) {
    throw new UsageError(`--page-id must be a page's numeric id, not ${flags["page-id"]}`);
  }
  if (flags.title !== undefined && flags["page-id"] === undefined) {
    throw new UsageError("--title goes with --page-id");
  }
  const error = flags.error?.trim();
  if (error === "") {
    throw new UsageError("--error needs a reason");
  }
  const title = flags.title?.trim().slice(0, MAX_PAGE_TITLE);
  const agent = requireAgent(requireSessionId(cli.env));
  const body: ConfluenceExportReport =
    flags["page-id"] !== undefined
      ? { export_id: exportId, page_id: flags["page-id"], ...(title ? { title } : {}) }
      : { export_id: exportId, error: (error ?? "").slice(0, MAX_CONFLUENCE_ERROR) };
  await cli.api().putConfluenceExport(agent.agent_id, body).catch(noExport("Confluence"));
  cli.print(
    flags["page-id"] !== undefined ? `agent-hub: reported page ${flags["page-id"]} for export ${exportId}` : `agent-hub: reported export ${exportId} as failed`
  );
  return 0;
};

// The whole export as one command, so the session spends one tool call on it rather than one per step.
const confluenceExport: ExportStep = async (cli, exportId, flags) => {
  const spaceId = flags["space-id"] ?? "";
  const parentId = flags["parent-id"] ?? "";
  if (!CONFLUENCE_ID_RE.test(spaceId)) {
    throw new UsageError("confluence export needs --space-id, a Confluence space's numeric id");
  }
  if (!CONFLUENCE_ID_RE.test(parentId)) {
    throw new UsageError("confluence export needs --parent-id, the numeric id of the page to put it under");
  }
  const agent = requireAgent(requireSessionId(cli.env));
  const api = cli.api();
  const outcome = await runConfluenceExport(
    {
      api,
      agentId: agent.agent_id,
      env: cli.env,
      run,
      login: virtualAgent(cli.env) ? () => atlassianLogin({ api, env: cli.env }) : null,
      print: cli.print
    },
    { exportId, spaceId, parentId }
  ).catch(noExport("Confluence"));
  if ("error" in outcome) {
    cli.print(`agent-hub: no page was created for export ${exportId}: ${outcome.error} The user has been shown this.`);
    return 1;
  }
  cli.print(
    `agent-hub: ${outcome.again ? "already created" : "created"} the page "${outcome.title}" (${outcome.pageId}) for export ${exportId} and reported it; the user's Assistant shows a link to it`
  );
  return 0;
};

export const jira = exportCommand("jira", {
  exportIdRe: EXPORT_ID_RE,
  exportFlags: ["project", "type", "labels"],
  reportFlags: ["key", "error"],
  export: jiraExport,
  report: jiraReport
});

export const confluence = exportCommand("confluence", {
  exportIdRe: CONFLUENCE_EXPORT_ID_RE,
  exportFlags: ["space-id", "parent-id"],
  reportFlags: ["page-id", "title", "error"],
  export: confluenceExport,
  report: confluenceReport
});
