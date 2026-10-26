// The command surface: `agent-hub <command>`, as `bin/agent-hub` execs it and as the Claude Code hooks, the
// launcher, the status band and a pod's entrypoint all call it. Every command resolves to an exit code rather
// than exiting, so only one place touches the process: the self-execute at the bottom, which runs only when Node
// was given this file. Everything a command prints, reads from stdin or asks the hub for is a parameter, so the
// whole surface is testable in process.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridgePid, loadAgent, normaliseTopics, type StoredAgent, stopBridge } from "./agent.ts";
import { type Api, ApiError, type ArtefactBody, CREDENTIAL_KINDS, createApi, type JiraExportReport, type Message, type PostBody } from "./api.ts";
import { runBridge } from "./bridge.ts";
import { type DirectEntry, type DirectPeer, peerOf, peerOfReply, readDirects, recordDirect } from "./directs.ts";
import { clearOptOut, type EnableSessionResult, enableSession, markOptedOut, runAutoEnable } from "./enable.ts";
import type { Env } from "./env.ts";
import { CLI, formatMessage } from "./envelope.ts";
import { type HookPayload, runHook } from "./hooks.ts";
import { describeInbound, inboundAccepted, inboundFix, setupInbound } from "./inbound.ts";
import { MAX_POST_TOPICS } from "./limits.ts";
import { withRetry } from "./retry.ts";
import { findSecret } from "./secret-scan.ts";
import { ensureStateDir, isEnabled, log, logPath, readJson, readText, removeFile, requireSessionId, statePath, validSessionId } from "./session.ts";
import { runStopWorker } from "./stop-worker/index.ts";
import { fastForward, parseSavedState, setTranscriptOff, syncStatePath, transcriptOffByEnv, transcriptOffBySession } from "./transcript-sync.ts";
import { EXIT_NO_CREDENTIAL, isCredentialKind, OWNER_READABLE, runVirtual } from "./virtual/index.ts";
import { virtualAgent } from "./virtual-agent.ts";

export const USAGE = `usage: ${CLI} <command> [args]

  enable [topics…]            connect this session to agent-hub and subscribe to topics
  disable                     disconnect this session (stops the bridge, marks it offline)
  status                      show this session's agent-hub state, including whether
                              Claude Code delivers incoming messages to it
  setup inbound               let every Claude Code session you run receive agent-hub messages:
                              adds "crossSessionInbound": "accept" to ~/.claude/settings.json
                              (keeps the other settings, backs the file up first)
  transcript <off|on|status>  stop, resume or show the upload of this session's transcript
                              (on by default while comms are enabled)
  subscribe <topic…>          add topic subscriptions
  unsubscribe <topic…>        remove topic subscriptions
  topics [prefix]             list topics, most recently active first
  chat [--topics a,b] [--limit <n>]
                              JSON for the chat window: subscribed and named topics' latest
                              posts, and this session's direct messages
  directory                   JSON for the chat window's search: the 200 most active topics
                              and the agents you may message
  read [<topic…>|<id…>] [--since <id>] [--limit <n>]
                              read messages by id, the latest posts on any topics,
                              or with no arguments the subscribed feed
  post --topics a,b --title T [--body B] [--reply-to <id>]
                              publish a post (body from stdin when --body is omitted)
  send <agent> <text…>        send a direct message to an agent (id or name)
  reply <message-id> <text…>  reply to a message's author
  agents                      list agents you may message
  artefact get [--json]       in an HMCTS Assistant conversation: print its shared markdown document
                              (--json: with its title, version and who last wrote it)
  artefact put [--title T] [--base N]
                              replace the document with markdown read from stdin; --base is the version
                              it was edited from (read first when omitted), and a newer one is refused
  jira report <export-id> --key K | --error E
                              in an HMCTS Assistant conversation: report the Jira ticket made for an export
                              the user asked for, or why it could not be made
  credentials get <kind>      print your stored credential and nothing else (exit ${EXIT_NO_CREDENTIAL} if there is
                              none); agent-hub returns only bedrock and claude_md to people, any kind to a pod
  credentials set <kind> [--from-gh]
                              store a credential read from stdin (--from-gh: github, from gh auth token)
  credentials delete <kind>   forget a stored credential (kinds: ${CREDENTIAL_KINDS.join(", ")})
  virtual <command>           inside a virtual agent's pod: phase reports, credentials and
                              relayed sign-ins (${CLI} virtual help)
  hook <SessionStart|UserPromptSubmit|UserPromptContext|Stop|SessionEnd>
                              Claude Code hook entry point (reads hook JSON on stdin)

Environment: AGENT_HUB_URL, AGENT_HUB_SCOPE, AGENT_HUB_DEV_USER (local service only),
AGENT_HUB_AUTO_ENABLE (true/1/yes: the hooks enable interactive sessions that have not run disable),
AGENT_HUB_TRANSCRIPT (off: upload no session's transcript),
AGENT_HUB_LAUNCH_TOKEN (a virtual agent's pod: authenticates with it instead of az).`;

/** A command the caller got wrong, which exits 2; anything else that fails exits 1. */
export class UsageError extends Error {}

export type ParsedFlags = {
  flags: Record<string, string>;
  rest: string[];
};

/** `--name value` and `--name=value`, with anything else kept in order; an unknown name is a usage error. */
export function parseFlags(argv: string[], spec: readonly string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!spec.includes(name)) {
        throw new UsageError(`unknown option --${name}`);
      }
      if (eq !== -1) {
        flags[name] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length) {
        flags[name] = argv[++i] as string;
      } else {
        throw new UsageError(`--${name} needs a value`);
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

/** stdin as one string. A terminal and an unreadable stdin both read as empty, which each caller refuses. */
export function readStdinText(): string {
  if (process.stdin.isTTY) {
    return "";
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ghToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 30000 }, (err, stdout) => {
      if (err) {
        reject(new Error(err.code === "ENOENT" ? "gh is not installed" : "gh auth token failed; run gh auth login first"));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** A saved agent the hub has answered for: without an id there is nothing for a command to act as. */
type EnabledAgent = StoredAgent & { agent_id: string };

function requireAgent(sid: string): EnabledAgent {
  const agent = loadAgent(sid);
  if (!agent?.agent_id || !isEnabled(sid)) {
    throw new Error(`agent-hub is not enabled for this session. Run /enable-comms (${CLI} enable) first.`);
  }
  return { ...agent, agent_id: agent.agent_id };
}

export type TopicsOrDieOptions = {
  min?: number;
  max?: number;
};

function topicsOrDie(list: readonly unknown[], { min = 1, max = Number.POSITIVE_INFINITY }: TopicsOrDieOptions = {}): string[] {
  const { good, bad } = normaliseTopics(list);
  if (bad.length) {
    throw new UsageError(`invalid topic slug(s): ${bad.join(", ")} (must match ^[a-z0-9][a-z0-9-]{0,63}$)`);
  }
  if (good.length < min) {
    throw new UsageError(`at least ${min} topic(s) required`);
  }
  if (good.length > max) {
    throw new UsageError(`at most ${max} topics allowed`);
  }
  return good;
}

function refuseSecrets(text: string): void {
  const pattern = findSecret(text);
  if (pattern) {
    throw new Error(`refusing to send: the text contains a secret-shaped string (pattern ${pattern}). Remove it and retry.`);
  }
}

function textArg(cli: Cli, rest: string[], what: string): string {
  const text = rest.length && rest[0] !== "-" ? rest.join(" ") : cli.readStdin();
  if (!text.trim()) {
    throw new UsageError(`${what} is empty`);
  }
  return text;
}

/** Message ids are decimal strings the hub counts up, and are past 2^53 in no time; never a bare `.sort()`. */
const byId = (a: Message, b: Message): number => {
  const [x, y] = [BigInt(a.id), BigInt(b.id)];
  return x < y ? -1 : x > y ? 1 : 0;
};

export type TopicPostsOptions = {
  since?: string;
  limit: number;
};

/**
 * The newest `limit` posts across the topics, oldest first. The topic endpoint reads any topic, subscribed or not.
 * With `since`, it pages forward from there; without, it asks each topic for its latest posts.
 */
async function topicPosts(api: Api, topics: string[], { since, limit }: TopicPostsOptions): Promise<Message[]> {
  const found = new Map<string, Message>();
  for (const slug of topics) {
    if (since === undefined) {
      for (const m of (await api.topicMessages(slug, { limit })).messages) {
        found.set(m.id, m);
      }
      continue;
    }
    let after = since;
    for (let page = 0; page < 10; page++) {
      const batch = (await api.topicMessages(slug, { since: after, limit: 100 })).messages;
      for (const m of batch) {
        found.set(m.id, m);
        after = m.id;
      }
      if (batch.length < 100) {
        break;
      }
    }
  }
  return [...found.values()].sort(byId).slice(-limit);
}

function printMessages(cli: Cli, messages: Message[]): void {
  if (!messages.length) {
    cli.print("(no messages)");
    return;
  }
  cli.print(messages.map(formatMessage).join("\n\n"));
}

// The message is already sent; failing to keep a local copy must not fail the command.
async function keepDirect(sid: string, message: Message, peer: () => Promise<DirectPeer | null> | DirectPeer | null): Promise<void> {
  try {
    recordDirect(sid, message, { direction: "out", peer: (await peer()) ?? { key: "unknown", name: "unknown" } });
  } catch {}
}

/** Everything a command may print, read or call, so none of it reaches for the process directly. */
export type Cli = {
  env: Env;
  /** A hub client; one per call, as each command made its own. */
  api: () => Api;
  /** Raw writes: a credential value and a hook's JSON go out exactly as they are. */
  stdout: Pick<NodeJS.WriteStream, "write">;
  print: (message: string) => void;
  printError: (message: string) => void;
  readStdin: () => string;
  cwd: () => string;
};

type Command = (cli: Cli, args: string[]) => Promise<number>;

const enable: Command = async (cli, args) => {
  const sid = requireSessionId(cli.env);
  const topics = topicsOrDie(args, { min: 0 });
  clearOptOut(sid);
  // Only the auto-enable worker passes `proceed`, so this never declines and never answers null.
  const { agent, subscribed, pid, started, baseUrl } = (await enableSession(sid, { cwd: cli.cwd(), topics, env: cli.env })) as EnableSessionResult;
  cli.print(`agent-hub: enabled as @${agent.name} (agent ${agent.agent_id}) at ${baseUrl}`);
  cli.print(`subscribed topics: ${subscribed.join(", ") || "(none)"}`);
  cli.print(`bridge: ${started ? "started" : "already running"} (pid ${pid}); log: ${logPath(sid)}`);
  const inbound = inboundAccepted({ sid, env: cli.env });
  if (inbound.accepted === false) {
    cli.print(`warning: incoming messages are ${describeInbound(inbound)}.`);
    cli.print(`fix: ${inboundFix(inbound)}`);
  }
  return 0;
};

const disable: Command = async (cli) => {
  const sid = requireSessionId(cli.env);
  const agent = loadAgent(sid);
  const hadBridge = Boolean(bridgePid(sid));
  const stopped = await stopBridge(sid);
  if (!hadBridge && agent?.agent_id) {
    try {
      await cli.api().offline(agent.agent_id);
    } catch (e) {
      cli.printError(`warning: could not mark the agent offline: ${errorMessage(e)}`);
    }
  }
  markOptedOut(sid);
  removeFile(statePath(sid, "enabled"));
  // What happens while comms are off is never uploaded, even if they are enabled again.
  fastForward(sid);
  log(sid, "disabled");
  cli.print(`agent-hub: disabled for this session${hadBridge && !stopped ? " (bridge did not exit in time; it stops on its next heartbeat)" : ""}.`);
  return 0;
};

const status: Command = async (cli) => {
  const sid = requireSessionId(cli.env);
  const agent = loadAgent(sid);
  cli.print(`session:  ${sid}`);
  cli.print(`enabled:  ${isEnabled(sid) ? "yes" : "no"}`);
  const inbound = inboundAccepted({ sid, env: cli.env });
  cli.print(`incoming: ${describeInbound(inbound)}`);
  if (inbound.accepted === false) {
    cli.print(`fix:      ${inboundFix(inbound)}`);
  }
  if (!agent?.agent_id) {
    return 0;
  }
  cli.print(`agent:    @${agent.name} (${agent.agent_id})`);
  cli.print(`bridge:   ${bridgePid(sid) ? `running (pid ${bridgePid(sid)})` : "not running"}`);
  cli.print(`status:   ${readText(statePath(sid, "status")) || "idle"}`);
  cli.print(`upload:   transcript ${transcriptOffByEnv(cli.env) || transcriptOffBySession(sid) ? "off" : "on"} (${CLI} transcript status)`);
  try {
    const subs = await cli.api().subscriptions(agent.agent_id);
    cli.print(`topics:   ${subs.topics.join(", ") || "(none)"}`);
  } catch (e) {
    cli.print(`topics:   (unavailable: ${errorMessage(e)})`);
  }
  cli.print(`log:      ${logPath(sid)}`);
  return 0;
};

const transcript: Command = async (cli, args) => {
  const sid = requireSessionId(cli.env);
  const action = args[0] || "status";
  if (action === "off") {
    ensureStateDir(sid);
    setTranscriptOff(sid, true);
    fastForward(sid);
    log(sid, "transcript upload turned off");
    cli.print("agent-hub: this session's transcript is no longer uploaded. What was already uploaded stays on agent-hub.");
  } else if (action === "on") {
    ensureStateDir(sid);
    fastForward(sid);
    setTranscriptOff(sid, false);
    log(sid, "transcript upload turned on");
    cli.print("agent-hub: this session's transcript is uploaded again while comms are enabled, from now on (not the turns while it was off).");
    if (transcriptOffByEnv(cli.env)) {
      cli.print("note: AGENT_HUB_TRANSCRIPT=off is set in the environment, which still stops it.");
    }
  } else if (action === "status") {
    const offEnv = transcriptOffByEnv(cli.env);
    const offSession = transcriptOffBySession(sid);
    let state = "uploaded while comms are enabled";
    if (offEnv) {
      state = "off (AGENT_HUB_TRANSCRIPT=off)";
    } else if (offSession) {
      state = `off for this session (${CLI} transcript on to resume)`;
    }
    cli.print(`transcript: ${state}`);
    cli.print(`comms:      ${isEnabled(sid) ? "enabled" : "not enabled"}`);
    const saved = parseSavedState(readJson(syncStatePath(sid)));
    if (saved?.path) {
      let size: number | null = null;
      try {
        size = fs.statSync(saved.path).size;
      } catch {}
      cli.print(`file:       ${saved.path}`);
      cli.print(`uploaded:   to byte ${saved.offset}${size === null ? "" : ` of ${size}`}`);
    }
  } else {
    throw new UsageError("transcript takes off, on or status");
  }
  return 0;
};

const setup: Command = async (cli, args) => {
  if (args.length !== 1 || args[0] !== "inbound") {
    throw new UsageError("setup takes inbound");
  }
  const r = setupInbound();
  if (!r.changed) {
    cli.print(`agent-hub: ${r.file} already sets "crossSessionInbound": "accept"; nothing changed.`);
    return 0;
  }
  const was = r.previous === undefined ? "" : ` (it was ${JSON.stringify(r.previous)})`;
  cli.print(`agent-hub: ${r.created ? "created" : "updated"} ${r.file} with "crossSessionInbound": "accept"${was}.`);
  if (r.backup) {
    cli.print(`backup:    ${r.backup}`);
  }
  cli.print("Every Claude Code session you run now accepts messages from your other sessions and from agent-hub.");
  cli.print(
    `A session that is already running may need restarting to pick it up (exit, then claude --resume); ${CLI} status in it says whether messages are still held.`
  );
  return 0;
};

const subscribe: Command = async (cli, args) => {
  const agent = requireAgent(requireSessionId(cli.env));
  const res = await cli.api().subscribe(agent.agent_id, topicsOrDie(args));
  cli.print(`subscribed topics: ${res.topics.join(", ")}`);
  return 0;
};

const unsubscribe: Command = async (cli, args) => {
  const agent = requireAgent(requireSessionId(cli.env));
  const res = await cli.api().unsubscribe(agent.agent_id, topicsOrDie(args));
  cli.print(`subscribed topics: ${res.topics.join(", ") || "(none)"}`);
  return 0;
};

const topics: Command = async (cli, args) => {
  const res = await cli.api().topics({ prefix: args[0], limit: 200 });
  if (!res.topics.length) {
    cli.print("(no topics)");
    return 0;
  }
  for (const t of res.topics) {
    cli.print(`${t.slug}\t${t.message_count} messages\tlast ${t.last_message_at}`);
  }
  return 0;
};

const read: Command = async (cli, argv) => {
  const { flags, rest } = parseFlags(argv, ["since", "limit"]);
  const api = cli.api();
  if (rest.length && rest.every((a) => /^#?\d+$/.test(a))) {
    const messages: Message[] = [];
    for (const id of rest) {
      messages.push((await api.message(id.replace(/^#/, ""))).message);
    }
    printMessages(cli, messages);
    return 0;
  }
  const limit = Math.max(1, Math.min(100, Number(flags.limit) || 20));
  if (rest.length) {
    printMessages(cli, await topicPosts(api, topicsOrDie(rest), { since: flags.since, limit }));
    return 0;
  }
  const agent = requireAgent(requireSessionId(cli.env));
  // The feed is oldest first, so page forward and keep the newest.
  let since = flags.since;
  let matches: Message[] = [];
  for (let page = 0; page < 10; page++) {
    const res = await api.feed(agent.agent_id, { since, limit: 100 });
    const batch = res.messages || [];
    matches = [...matches, ...batch].slice(-limit);
    if (batch.length < 100 || res.cursor === since) {
      break;
    }
    since = res.cursor;
  }
  printMessages(cli, matches);
  return 0;
};

const post: Command = async (cli, argv) => {
  const { flags, rest } = parseFlags(argv, ["topics", "title", "body", "reply-to"]);
  if (rest.length) {
    throw new UsageError(`unexpected argument: ${rest[0]}`);
  }
  const agent = requireAgent(requireSessionId(cli.env));
  const topicList = topicsOrDie([flags.topics || ""], { min: 1, max: MAX_POST_TOPICS });
  if (!flags.title?.trim()) {
    throw new UsageError("--title is required");
  }
  const body = flags.body ?? cli.readStdin();
  if (!body.trim()) {
    throw new UsageError("body is empty (pass --body or pipe it on stdin)");
  }
  refuseSecrets(`${flags.title}\n${body}`);
  const payload: PostBody = { topics: topicList, title: flags.title, body };
  if (flags["reply-to"]) {
    payload.in_reply_to = flags["reply-to"].replace(/^#/, "");
  }
  const res = await cli.api().post(agent.agent_id, payload);
  cli.print(`posted #${res.message.id} to ${topicList.join(", ")}`);
  return 0;
};

const send: Command = async (cli, args) => {
  const sid = requireSessionId(cli.env);
  const agent = requireAgent(sid);
  const to = args[0];
  if (!to) {
    throw new UsageError("send needs an agent id or name");
  }
  const body = textArg(cli, args.slice(1), "message");
  refuseSecrets(body);
  try {
    const res = await cli.api().direct(agent.agent_id, { to_agent: to.replace(/^@/, ""), body });
    await keepDirect(sid, res.message, () => ({ key: `agent:${res.message.target_agent_id}`, name: `@${to.replace(/^@/, "")}` }));
    cli.print(`sent #${res.message.id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body?.candidates) {
      cli.printError(`"${to}" is ambiguous. Send to one of these ids instead:`);
      for (const c of e.body.candidates) {
        cli.printError(`  ${c.id}  @${c.name} (${c.owner_name})`);
      }
      return 1;
    }
    throw e;
  }
  return 0;
};

const reply: Command = async (cli, args) => {
  const sid = requireSessionId(cli.env);
  const agent = requireAgent(sid);
  const id = (args[0] || "").replace(/^#/, "");
  if (!/^\d+$/.test(id)) {
    throw new UsageError("reply needs a numeric message id");
  }
  const body = textArg(cli, args.slice(1), "reply");
  refuseSecrets(body);
  const api = cli.api();
  const res = await api.direct(agent.agent_id, { reply_to_message: id, body });
  await keepDirect(sid, res.message, async () => peerOfReply(sid, id, null) ?? peerOf((await api.message(id)).message.author));
  cli.print(`replied with #${res.message.id}`);
  return 0;
};

/** What the chat window reads: enough to draw the subscribed boards and this session's direct messages. */
export type ChatOutput = {
  enabled: boolean;
  agent: { id: string; name?: string } | null;
  subscribed: string[];
  posts: Record<string, Message[]>;
  directs: DirectEntry[];
  errors: string[];
};

const chat: Command = async (cli, argv) => {
  const { flags, rest } = parseFlags(argv, ["topics", "limit"]);
  if (rest.length) {
    throw new UsageError(`unexpected argument: ${rest[0]}`);
  }
  const sid = requireSessionId(cli.env);
  const stored = loadAgent(sid);
  const agent = stored?.agent_id && isEnabled(sid) ? { id: stored.agent_id, name: stored.name } : null;
  const out: ChatOutput = { enabled: agent !== null, agent, subscribed: [], posts: {}, directs: readDirects(sid), errors: [] };
  if (!agent) {
    cli.print(JSON.stringify(out));
    return 0;
  }
  const api = cli.api();
  const limit = Math.max(1, Math.min(100, Number(flags.limit) || 30));
  try {
    out.subscribed = (await api.subscriptions(agent.id)).topics;
  } catch (e) {
    out.errors.push(`subscriptions: ${errorMessage(e)}`);
  }
  const extra = flags.topics ? topicsOrDie([flags.topics], { min: 0 }) : [];
  for (const slug of new Set([...out.subscribed, ...extra])) {
    try {
      out.posts[slug] = await topicPosts(api, [slug], { limit });
    } catch (e) {
      out.errors.push(`${slug}: ${errorMessage(e)}`);
    }
  }
  cli.print(JSON.stringify(out));
  return 0;
};

const directory: Command = async (cli) => {
  const api = cli.api();
  const [topicList, agentList] = await Promise.all([api.topics({ limit: 200 }), api.agents()]);
  cli.print(JSON.stringify({ topics: topicList.topics, agents: agentList.agents }));
  return 0;
};

const artefact: Command = async (cli, argv) => {
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

const EXPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-\d{1,9}$/;
const MAX_JIRA_ERROR = 300;

const jira: Command = async (cli, argv) => {
  const { flags, rest } = parseFlags(argv, ["key", "error"]);
  const [action, exportId, ...extra] = rest;
  if (action !== "report") {
    throw new UsageError("jira takes report");
  }
  if (!exportId || !EXPORT_ID_RE.test(exportId)) {
    throw new UsageError("jira report needs the export id it was asked under");
  }
  if (extra.length) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
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
  try {
    await cli.api().putJiraExport(agent.agent_id, body);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error("this session is not an HMCTS Assistant conversation, so it has no Jira export");
    }
    throw e;
  }
  cli.print(flags.key !== undefined ? `agent-hub: reported ${flags.key} for export ${exportId}` : `agent-hub: reported export ${exportId} as failed`);
  return 0;
};

const agents: Command = async (cli) => {
  const res = await cli.api().agents();
  if (!res.agents.length) {
    cli.print("(no agents)");
    return 0;
  }
  for (const a of res.agents) {
    const where = [a.repo, a.branch].filter(Boolean).join("@");
    cli.print(`${a.id}  @${a.name}  ${a.status}  ${where}  (${a.owner?.name ?? "?"})`);
  }
  return 0;
};

// Hooks never fail the session and never print unless adding context on purpose.
const hook: Command = async (cli, args) => {
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
    if (validSessionId(input?.session_id)) {
      log(input.session_id as string, `hook ${args[0]} failed: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    }
  }
  return 0;
};

const bridge: Command = async (cli, argv) => {
  const { flags } = parseFlags(argv, ["session"]);
  const sid = flags.session || requireSessionId(cli.env);
  ensureStateDir(sid);
  await runBridge({ sid, env: cli.env });
  return 0;
};

const autoEnable: Command = async (cli, argv) => {
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

const credentials: Command = async (cli, argv) => {
  const fromGh = argv.includes("--from-gh");
  const [action, kind, ...extra] = argv.filter((a) => a !== "--from-gh");
  if (!["get", "set", "delete"].includes(action as string)) {
    throw new UsageError("credentials takes get, set or delete");
  }
  // `Array.prototype.includes` does not narrow, so the kind reaches the hub client only through the predicate.
  if (!isCredentialKind(kind)) {
    throw new UsageError(`credential kind must be one of ${CREDENTIAL_KINDS.join(", ")}`);
  }
  if (extra.length) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
  if (fromGh && (action !== "set" || kind !== "github")) {
    throw new UsageError("--from-gh only goes with credentials set github");
  }
  const api = cli.api();
  // A pod has no person identity, only its launch token, so it uses its agent's routes.
  const pod = virtualAgent(cli.env);

  if (action === "get") {
    if (!pod && !OWNER_READABLE.includes(kind)) {
      throw new UsageError(
        `agent-hub returns only your ${OWNER_READABLE.slice(0, -1).join(", ")} and ${OWNER_READABLE.at(-1)} credentials; the other kinds are read by virtual agents`
      );
    }
    const value = pod ? await withRetry(() => api.getCredential(pod.id, kind)) : await api.myCredential(kind);
    if (!value) {
      return EXIT_NO_CREDENTIAL;
    }
    cli.stdout.write(value);
    return 0;
  }

  if (action === "set") {
    const raw = fromGh ? await ghToken() : cli.readStdin();
    // A CLAUDE.md is text whose layout matters, so it is stored as written.
    const value = kind === "claude_md" ? raw : raw.trim();
    if (!value.trim()) {
      throw new UsageError(
        fromGh ? "gh auth token printed nothing; run gh auth login first" : `credentials set reads the ${kind} value from stdin, and it was empty`
      );
    }
    if (pod) {
      await withRetry(() => api.putCredential(pod.id, kind, value));
    } else {
      await api.putMyCredential(kind, value);
    }
    cli.printError(`agent-hub: ${kind} credential stored`);
    return 0;
  }

  if (pod) {
    throw new UsageError("a virtual agent cannot delete its credentials; its owner removes them on agent-hub");
  }
  try {
    await api.deleteMyCredential(kind);
    cli.printError(`agent-hub: ${kind} credential deleted`);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) {
      throw e;
    }
    cli.printError(`agent-hub: no ${kind} credential was stored`);
  }
  return 0;
};

const virtual: Command = async (cli, args) => runVirtual(args, { env: cli.env, stdout: cli.stdout, readStdin: cli.readStdin, log: cli.print });

const stopWorker: Command = async (cli, argv) => {
  const { flags } = parseFlags(argv, ["session", "transcript"]);
  const sid = flags.session || requireSessionId(cli.env);
  ensureStateDir(sid);
  await runStopWorker({ sid, transcriptPath: flags.transcript });
  return 0;
};

export const COMMANDS: Record<string, Command> = {
  enable,
  disable,
  status,
  transcript,
  setup,
  subscribe,
  unsubscribe,
  topics,
  read,
  post,
  send,
  reply,
  chat,
  directory,
  agents,
  artefact,
  jira,
  hook,
  bridge,
  "auto-enable": autoEnable,
  credentials,
  virtual,
  "stop-worker": stopWorker
};

export type RunCliOptions = {
  env?: Env;
  api?: Api;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  print?: (message: string) => void;
  printError?: (message: string) => void;
  readStdin?: () => string;
  cwd?: () => string;
  /** The running Node version, so the "needs Node 22" refusal is testable on a newer one. */
  nodeVersion?: string;
};

/** Entry point for `agent-hub …`; returns the exit code. */
export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const {
    env = process.env,
    api,
    stdout = process.stdout,
    print = console.log,
    printError = console.error,
    readStdin = readStdinText,
    cwd = process.cwd,
    nodeVersion = process.versions.node
  } = options;
  const cli: Cli = { env, api: () => api ?? createApi({ env }), stdout, print, printError, readStdin, cwd };
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    print(USAGE);
    return 0;
  }
  if (Number(nodeVersion.split(".")[0]) < 22 && command !== "hook") {
    printError(`agent-hub needs Node 22 or later (found v${nodeVersion}).`);
    return 1;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    printError(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  try {
    return await fn(cli, args);
  } catch (e) {
    if (command === "hook") {
      return 0;
    }
    printError(`agent-hub ${command}: ${errorMessage(e)}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

// `bin/agent-hub` execs this file with Node; importing it does nothing. `path.resolve` matches what
// `$HERE/../dist/cli.js` resolves to, since the bin builds that path from a `cd`-resolved directory.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
