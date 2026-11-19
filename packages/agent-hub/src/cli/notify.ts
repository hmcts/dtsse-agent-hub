// `agent-hub notify`: a CFT Workspace conversation's GOV.UK Notify templates, any number of them; without `--id`, `get` and
// `put` are the primary, the oldest. `products`, `list --product` and `pull` read Notify on this machine with the person's own `az login`, through the functions the Notify panel's pod jobs run, so the
// product's Notify key stays here. `get` writes the latest version out as files, recording the version and revision it
// read, and `put` publishes the edited files as the next version on that base, so a version someone else wrote in
// between, or the person's amend of the one read, is refused rather than overwritten. Nothing here changes Notify.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiError } from "../api.ts";
import { loadNotify, MAX_BODY, MAX_SUBJECT } from "../assistant/notify-tools.ts";
import { PodJobError } from "../assistant/pod-jobs.ts";
import { CLI } from "../envelope.ts";
import { requireSessionId } from "../session.ts";
import type { NotifyResponse, NotifyTemplateType } from "../wire.ts";
import { type Cli, type Command, parseFlags, refuseSecrets, requireAgent, UsageError } from "./command.ts";
import { checkSummary, jsonbText } from "./docmosis.ts";

const MAX_DATA_BYTES = 40_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VERSION_FILE = "version";
const REVISION_FILE = "revision";
const SUBJECT_FILE = "subject.md";
const BODY_FILE = "body.md";
const DATA_FILE = "data.json";
const TEMPLATE_FILE = "template.json";

const utf8 = new TextEncoder();

/** Where `get` writes a conversation's Notify template: one directory per conversation, under the home directory. */
export function notifyDir(cli: Cli, conversation: string, id?: string): string {
  const dir = path.join(cli.env.HOME || os.homedir(), ".agent-hub", "notify", conversation);
  return id === undefined ? dir : path.join(dir, id);
}

/** `--id`: a template of the conversation, as `notify list` prints it; left out, the primary. */
function idFlag(flags: Record<string, string>, command: string): string | undefined {
  if (flags.id === undefined) {
    return undefined;
  }
  if (!UUID_RE.test(flags.id.trim())) {
    throw new UsageError(`notify ${command} --id takes a template id from ${CLI} notify list`);
  }
  return flags.id.trim().toLowerCase();
}

/** `--id` as the command line to repeat it: empty for the primary. */
const idArg = (id: string | undefined): string => (id === undefined ? "" : ` --id ${id}`);

function recordedNumber(dir: string, name: string): number | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, name), "utf8").trim();
  } catch {
    return undefined;
  }
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

function record(dir: string, version: number, revision: number): void {
  fs.writeFileSync(path.join(dir, VERSION_FILE), `${version}\n`);
  fs.writeFileSync(path.join(dir, REVISION_FILE), `${revision}\n`);
}

/** A failure reading Notify, in the package's own words, which exits 1 rather than printing a stack. */
async function reportingNotify(cli: Cli, work: () => Promise<number>): Promise<number> {
  try {
    return await work();
  } catch (e) {
    const failure = e instanceof PodJobError ? e : (await loadNotify().catch(() => undefined))?.notifyFailure(e);
    if (failure === undefined) {
      throw e;
    }
    cli.printError(`agent-hub notify: ${failure.detail ?? failure.code}`);
    return 1;
  }
}

function noArgs(rest: string[]): void {
  if (rest.length) {
    throw new UsageError(`unexpected argument: ${rest[0]}`);
  }
}

async function products(cli: Cli, argv: string[]): Promise<number> {
  noArgs(parseFlags(argv, []).rest);
  return await reportingNotify(cli, async () => {
    for (const product of (await loadNotify()).notifyProducts()) {
      cli.print(`${product.id}\t${product.label}${product.note === undefined ? "" : ` (${product.note})`}`);
    }
    return 0;
  });
}

function productFlag(flags: Record<string, string>, command: string): string {
  if (flags.product === undefined || flags.product.trim() === "") {
    throw new UsageError(`notify ${command} needs --product, one of the ids ${CLI} notify products lists`);
  }
  return flags.product.trim();
}

/** The conversation's own templates, oldest first: what `list` prints without `--product`. */
async function listHeld(cli: Cli): Promise<number> {
  const agent = requireAgent(requireSessionId(cli.env));
  let held: { notify_templates: { id: string; name: string; version: number; updated_by: string | null }[] };
  try {
    held = await cli.api().listNotify(agent.agent_id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      cli.printError("agent-hub notify: this session is not a CFT Workspace conversation, or its hub is older than several Notify templates");
      return 1;
    }
    throw e;
  }
  for (const template of held.notify_templates) {
    cli.print(`${template.id}\tv${template.version}\t${template.updated_by === "user" ? "user" : "assistant"}\t${template.name}`);
  }
  if (held.notify_templates.length === 0) {
    cli.print(`agent-hub: the conversation has no Notify template yet. Load one with ${CLI} notify pull.`);
  }
  return 0;
}

async function list(cli: Cli, argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv, ["product"]);
  noArgs(rest);
  if (flags.product === undefined) {
    return await listHeld(cli);
  }
  const product = productFlag(flags, "list");
  return await reportingNotify(cli, async () => {
    const { templates, truncated } = await (await loadNotify()).listNotifyTemplates(product);
    for (const template of templates) {
      cli.print(`${template.type}\t${template.id}\tv${template.version}\t${template.name}`);
    }
    if (templates.length === 0) {
      cli.print(`agent-hub: ${product}'s Notify service has no templates`);
    }
    if (truncated) {
      cli.print(`agent-hub: only the first ${templates.length} templates are listed`);
    }
    return 0;
  });
}

async function pull(cli: Cli, argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv, ["product", "template", "id"]);
  noArgs(rest);
  const product = productFlag(flags, "pull");
  const target = idFlag(flags, "pull");
  const template = flags.template?.trim() ?? "";
  if (!UUID_RE.test(template)) {
    throw new UsageError(`notify pull needs --template, a template id from ${CLI} notify list`);
  }
  const agent = requireAgent(requireSessionId(cli.env));
  return await reportingNotify(cli, async () => {
    const loaded = await (await loadNotify()).pullNotifyTemplate({ productId: product, templateId: template, agentId: agent.agent_id, target, api: cli.api() });
    cli.print(
      loaded.written
        ? `agent-hub: loaded "${loaded.name}" into the conversation as version ${loaded.version} of its Notify template ${loaded.id}`
        : `agent-hub: "${loaded.name}" is already a Notify template of the conversation (${loaded.id}), as version ${loaded.version}; nothing was written`
    );
    cli.print(`Run ${CLI} notify get --id ${loaded.id} to work on it.`);
    return 0;
  });
}

function getArgs(argv: string[]): { version: number | undefined; id: string | undefined } {
  const { flags, rest } = parseFlags(argv, ["version", "id"]);
  noArgs(rest);
  if (flags.version !== undefined && !/^[1-9]\d{0,8}$/.test(flags.version)) {
    throw new UsageError("--version takes a version number from 1");
  }
  return { version: flags.version === undefined ? undefined : Number(flags.version), id: idFlag(flags, "get") };
}

/** What `get` keeps beside the text: what the template is, which `put` reads its type from. */
type TemplateFile = Pick<NotifyResponse, "version" | "revision" | "product" | "template_id" | "service_id" | "type" | "name" | "notify_version" | "by">;

async function get(cli: Cli, argv: string[]): Promise<number> {
  const { version, id } = getArgs(argv);
  const agent = requireAgent(requireSessionId(cli.env));
  let template: NotifyResponse;
  try {
    template = id === undefined ? await cli.api().getNotify(agent.agent_id, version) : await cli.api().getNotifyById(agent.agent_id, id, version);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      cli.printError(
        version === undefined
          ? `agent-hub notify: the conversation has no Notify template yet, or this session is not a CFT Workspace conversation. Load one with ${CLI} notify pull.`
          : `agent-hub notify: the Notify template does not keep version ${version}, or the conversation has none`
      );
      return 1;
    }
    throw e;
  }
  const dir = notifyDir(cli, agent.conversation_id ?? agent.agent_id, id);
  // An older version is written to a directory of its own rather than over the working copy.
  const isLatest = template.current_version === undefined || template.current_version === template.version;
  const into = isLatest ? dir : path.join(dir, `v${template.version}`);
  fs.mkdirSync(into, { recursive: true });
  const subjectFile = path.join(into, SUBJECT_FILE);
  if (template.subject === null) {
    fs.rmSync(subjectFile, { force: true });
  } else {
    fs.writeFileSync(subjectFile, template.subject);
  }
  fs.writeFileSync(path.join(into, BODY_FILE), template.body);
  fs.writeFileSync(path.join(into, DATA_FILE), `${JSON.stringify(template.data, null, 2)}\n`);
  const about: TemplateFile = {
    version: template.version,
    revision: template.revision,
    product: template.product,
    template_id: template.template_id,
    service_id: template.service_id,
    type: template.type,
    name: template.name,
    notify_version: template.notify_version,
    by: template.by
  };
  fs.writeFileSync(path.join(into, TEMPLATE_FILE), `${JSON.stringify(about, null, 2)}\n`);
  if (isLatest) {
    record(dir, template.version, template.revision);
  }
  const who = template.by === "user" ? "the user" : "this conversation";
  const changed = template.subject !== template.notify_subject || template.body !== template.notify_body;
  cli.print(`agent-hub: wrote version ${template.version} (revision ${template.revision}) of the ${template.type} template "${template.name}" to ${into}`);
  cli.print(`Taken from version ${template.notify_version} of the template in Notify, ${changed ? "and changed since" : "unchanged"}; last written by ${who}.`);
  if (!isLatest) {
    cli.print(`This is not the latest version, which is ${template.current_version}, and the recorded base is unchanged.`);
    return 0;
  }
  const files = template.subject === null ? `${BODY_FILE}` : `${SUBJECT_FILE} and ${BODY_FILE}`;
  cli.print(
    `Edit ${files} (Notify's markdown, with ((placeholders))) and ${DATA_FILE} (the personalisation the person previews it with), then publish them with ${CLI} notify put${idArg(id)} [--summary S], which is refused if someone has written a newer version. The person copies the draft into Notify themselves.`
  );
  return 0;
}

function readText(file: string, what: string, max: number): string {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new UsageError(`cannot read the ${what}, ${file}: ${(e as Error).message}. Run ${CLI} notify get first.`);
  }
  if (text.length > max) {
    throw new UsageError(`the ${what}, ${file}, is longer than the hub takes, ${max} characters`);
  }
  if (jsonbText(text) === undefined) {
    throw new UsageError(`the ${what}, ${file}, has text the hub cannot store: a NUL character, or half of a surrogate pair`);
  }
  return text;
}

function readData(file: string): Record<string, unknown> {
  const text = readText(file, "personalisation", MAX_DATA_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(`${file} must hold the personalisation as one object`);
  }
  const stored = jsonbText(parsed);
  if (stored === undefined || utf8.encode(stored).byteLength > MAX_DATA_BYTES) {
    throw new UsageError(`the personalisation, ${file}, is larger than the hub takes, ${MAX_DATA_BYTES} bytes as the hub stores it`);
  }
  return parsed as Record<string, unknown>;
}

function recordedType(dir: string): NotifyTemplateType {
  let about: Partial<TemplateFile>;
  try {
    about = JSON.parse(fs.readFileSync(path.join(dir, TEMPLATE_FILE), "utf8")) as Partial<TemplateFile>;
  } catch {
    throw new UsageError(`there is no ${TEMPLATE_FILE} in ${dir}. Run ${CLI} notify get first.`);
  }
  if (about.type !== "email" && about.type !== "sms" && about.type !== "letter") {
    throw new UsageError(`${path.join(dir, TEMPLATE_FILE)} does not say what type of template it is. Run ${CLI} notify get again.`);
  }
  return about.type;
}

function printConflict(cli: Cli, base: number, baseRevision: number | undefined, current: NotifyResponse | undefined, id: string | undefined): void {
  if (baseRevision !== undefined && current?.version === base && current.revision !== baseRevision) {
    cli.printError(`agent-hub notify: the user has changed version ${base} of the Notify template since you read it. Nothing was saved.`);
  } else {
    const by = current === undefined ? "" : `, last written by ${current.by === "user" ? "the user" : "this conversation"}`;
    cli.printError(
      `agent-hub notify: the Notify template has changed since version ${base}: it is now version ${current?.version ?? "?"}${by}. Nothing was saved.`
    );
  }
  cli.printError(`Run ${CLI} notify get${idArg(id)}, merge your change into the files it writes, and put again.`);
}

async function put(cli: Cli, argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv, ["summary", "id"]);
  noArgs(rest);
  const summary = flags.summary === undefined ? undefined : checkSummary(flags.summary);
  const id = idFlag(flags, "put");
  const agent = requireAgent(requireSessionId(cli.env));
  const dir = notifyDir(cli, agent.conversation_id ?? agent.agent_id, id);
  const base = recordedNumber(dir, VERSION_FILE);
  if (base === undefined) {
    throw new UsageError(`nothing to put: run ${CLI} notify get${idArg(id)} first, edit the files it writes, then put them`);
  }
  const baseRevision = recordedNumber(dir, REVISION_FILE);
  const type = recordedType(dir);
  const subject = type === "sms" ? null : readText(path.join(dir, SUBJECT_FILE), "subject", MAX_SUBJECT);
  const body = readText(path.join(dir, BODY_FILE), "body", MAX_BODY);
  const data = readData(path.join(dir, DATA_FILE));
  refuseSecrets(`${subject ?? ""}\n${body}\n${JSON.stringify(data)}`);
  let written: { version: number; revision: number };
  try {
    const draft = {
      subject,
      body,
      data,
      base_version: base,
      ...(baseRevision === undefined ? {} : { base_revision: baseRevision }),
      ...(summary === undefined ? {} : { summary })
    };
    written = id === undefined ? await cli.api().putNotify(agent.agent_id, draft) : await cli.api().putNotifyById(agent.agent_id, id, draft);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      printConflict(cli, base, baseRevision, e.body?.current as NotifyResponse | undefined, id);
      return 1;
    }
    if (e instanceof ApiError && e.status === 404) {
      cli.printError("agent-hub notify: this session is not a CFT Workspace conversation, or it has no such Notify template");
      return 1;
    }
    throw e;
  }
  record(dir, written.version, written.revision);
  cli.print(`agent-hub: published the Notify template's draft as version ${written.version}`);
  return 0;
}

async function remove(cli: Cli, argv: string[]): Promise<number> {
  const { flags, rest } = parseFlags(argv, ["id"]);
  noArgs(rest);
  const id = idFlag(flags, "remove");
  if (id === undefined) {
    throw new UsageError(`notify remove needs --id, a template id from ${CLI} notify list`);
  }
  const agent = requireAgent(requireSessionId(cli.env));
  try {
    await cli.api().deleteNotify(agent.agent_id, id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      cli.printError("agent-hub notify: the conversation has no such Notify template");
      return 1;
    }
    throw e;
  }
  fs.rmSync(notifyDir(cli, agent.conversation_id ?? agent.agent_id, id), { recursive: true, force: true });
  cli.print(`agent-hub: removed the Notify template ${id} from the conversation`);
  return 0;
}

export const notify: Command = async (cli, argv) => {
  const [action, ...rest] = argv;
  if (action === "products") {
    return await products(cli, rest);
  }
  if (action === "list") {
    return await list(cli, rest);
  }
  if (action === "pull") {
    return await pull(cli, rest);
  }
  if (action === "get") {
    return await get(cli, rest);
  }
  if (action === "put") {
    return await put(cli, rest);
  }
  if (action === "remove") {
    return await remove(cli, rest);
  }
  throw new UsageError("notify takes products, list, pull, get, put or remove");
};
