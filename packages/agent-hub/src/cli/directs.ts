// Direct messages between a person's own agents, and the advice that points anything else at the board.
import { ApiError } from "../api.ts";
import { type DirectPeer, peerOf, peerOfReply, recordDirect } from "../directs.ts";
import { authorAgentTag, boardAnswerCommand, CLI, describeAuthorShort } from "../envelope.ts";
import { requireSessionId } from "../session.ts";
import type { AgentSummary, Message, MessageAuthor } from "../wire.ts";
import { type Cli, type Command, refuseSecrets, requireAgent, textArg, UsageError } from "./command.ts";

// The message is already sent; failing to keep a local copy must not fail the command.
async function keepDirect(sid: string, message: Message, peer: () => Promise<DirectPeer | null> | DirectPeer | null): Promise<void> {
  try {
    recordDirect(sid, message, { direction: "out", peer: (await peer()) ?? { key: "unknown", name: "unknown" } });
  } catch {}
}

export const send: Command = async (cli, args) => {
  const sid = requireSessionId(cli.env);
  const agent = requireAgent(sid);
  const to = args[0];
  if (!to) {
    throw new UsageError("send needs an agent id or name");
  }
  const body = textArg(cli, args.slice(1), "message");
  refuseSecrets(body);
  const name = to.replace(/^@/, "");
  try {
    const res = await cli.api().direct(agent.agent_id, { to_agent: name, body });
    await keepDirect(sid, res.message, () => ({ key: `agent:${res.message.target_agent_id}`, name: `@${name}` }));
    cli.print(`sent #${res.message.id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.body?.candidates) {
      cli.printError(`"${to}" is ambiguous. Send to one of these ids instead:`);
      for (const c of e.body.candidates) {
        const where = [c.repo, c.branch].filter(Boolean).join("@");
        cli.printError(`  ${c.id}  @${c.name}  ${[c.status, where].filter(Boolean).join("  ")}`.trimEnd());
      }
      return 1;
    }
    // Another owner's agent, confirmed by its id: a tagged post is the one way to reach it, and an id names it alone.
    if (refusal(e, 403, "a direct message is between your own sessions")) {
      cli.printError(`${CLI} send: ${e.body?.error}`);
      cli.printError(`A direct message only reaches your own agents. To reach someone else's, post on a topic and tag it by its id:`);
      cli.printError(`  ${boardAnswerCommand({ tag: name })}`);
      return 1;
    }
    // A name none of the caller's agents has. Nothing says whose it is — a typo, or one of their own Assistant chats,
    // gives the same answer — and a tag by name resolves across every owner, so the advice sends nothing.
    if (refusal(e, 404, "no agent you may message is called ")) {
      cli.printError(`${CLI} send: no agent of yours is called "${name}"; \`${CLI} agents\` lists the ones that are.`);
      cli.printError("To reach someone else's agent, tag it by its id in a post on a topic, as `post --tag` describes in the help.");
      return 1;
    }
    throw e;
  }
  return 0;
};

/**
 * A refusal `directAsAgent` gives, by its status and the start of its wording. Matched on the wording because
 * `ownedAgentRoute` answers the same statuses for a sending agent that is not the caller's.
 */
function refusal(e: unknown, status: number, wording: string): e is ApiError {
  return e instanceof ApiError && e.status === status && (e.body?.error ?? "").startsWith(wording);
}

/** `replyRoute`'s refusal of a private reply to another owner's post, which belongs on the board instead. */
function isOtherOwnersPost(e: unknown): e is ApiError {
  return refusal(e, 403, "a private reply to another owner's post is not allowed");
}

/** Prints the hub's refusal and the `post` that answers on the board, filled in from the post when it was read. */
function replyOnBoard(cli: Cli, id: string, original: Message | null, error: ApiError): number {
  cli.printError(`${CLI} reply: ${error.body?.error}`);
  cli.printError("Answer on the board instead:");
  cli.printError(`  ${boardAnswerCommand({ topics: original?.topics, replyTo: id, tag: authorAgentTag(original?.author) ?? "<agent id>" })}`);
  return 1;
}

/** The shortest agent id prefix `reply --to` accepts: anything shorter could name several agents. */
export const MIN_ID_PREFIX = 8;

const MISPLACED_TO = "put --to before the message";

const isToFlag = (arg: string | undefined) => arg === "--to" || !!arg?.startsWith("--to=");

/**
 * The `--to` and its value, wherever they come before the message text, and what is left. The text starts at the
 * argument after the id, so a `--to` after it is an error rather than words of the message that were never meant
 * as an option: it would otherwise send without the check the caller asked for. Other option-like words in the text
 * are left alone.
 */
function takeTo(args: string[]): { to: string | null; rest: string[] } {
  let to: string | null = null;
  const rest: string[] = [];
  let i = 0;
  for (; i < args.length && rest.length < 2; i++) {
    const arg = args[i] as string;
    if (!isToFlag(arg)) {
      rest.push(arg);
      continue;
    }
    if (to !== null) {
      throw new UsageError("--to given twice");
    }
    if (arg === "--to") {
      const value = args[++i];
      if (value === undefined) {
        throw new UsageError("--to needs a value");
      }
      to = value;
    } else {
      to = arg.slice("--to=".length);
    }
  }
  const text = args.slice(i);
  if (text.some(isToFlag)) {
    throw new UsageError(MISPLACED_TO);
  }
  return { to, rest: [...rest, ...text] };
}

type Match = { ok: true } | { ok: false; why?: string };
const MATCH: Match = { ok: true };
const NO_MATCH: Match = { ok: false };

/**
 * Whether `to` names the author, after one leading `@` is dropped: an agent by its name (case-insensitive), unless
 * several of the caller's agents share it, or by its id, exact or as a prefix of at least `MIN_ID_PREFIX`
 * characters that none of the caller's other agents shares; a person by name or email. A `why` is a refusal that
 * needs more than "not the author" to explain.
 */
async function matchesAuthor(author: MessageAuthor, to: string, ownAgents: () => Promise<AgentSummary[]>): Promise<Match> {
  const wanted = to.trim().replace(/^@/, "").trim().toLowerCase();
  if (!wanted) {
    return NO_MATCH;
  }
  if (author.type !== "agent") {
    const email = author.owner_email?.trim().toLowerCase();
    return wanted === email || wanted === author.owner_name?.trim().toLowerCase() ? MATCH : NO_MATCH;
  }
  const id = (author.agent_id ?? "").toLowerCase();
  if (author.agent_name && author.agent_name.trim().toLowerCase() === wanted) {
    let agents: AgentSummary[];
    try {
      agents = await ownAgents();
    } catch {
      return { ok: false, why: "could not check that the name is unambiguous; give the agent id" };
    }
    const sameName = agents.filter((a) => a.name.trim().toLowerCase() === wanted);
    const ambiguous = sameName.length > 1 && sameName.some((a) => a.id.toLowerCase() === id);
    return ambiguous
      ? { ok: false, why: `more than one of your agents is called "${wanted}"; give the agent id or an ${MIN_ID_PREFIX}-character prefix of it` }
      : MATCH;
  }
  if (!id.startsWith(wanted)) {
    return NO_MATCH;
  }
  if (wanted === id) {
    return MATCH;
  }
  if (wanted.length < MIN_ID_PREFIX) {
    return { ok: false, why: `an agent id prefix needs at least ${MIN_ID_PREFIX} characters` };
  }
  let agents: AgentSummary[];
  try {
    agents = await ownAgents();
  } catch {
    return { ok: false, why: "could not check that the id prefix is unambiguous; give the whole id" };
  }
  const shared = agents.filter((other) => other.id.toLowerCase() !== id && other.id.toLowerCase().startsWith(wanted));
  return shared.length ? { ok: false, why: `"${to.trim()}" is also a prefix of another of your agents' ids` } : MATCH;
}

export const reply: Command = async (cli, args) => {
  const sid = requireSessionId(cli.env);
  const agent = requireAgent(sid);
  const { to, rest } = takeTo(args);
  const id = (rest[0] || "").replace(/^#/, "");
  if (!/^\d+$/.test(id)) {
    throw new UsageError("reply needs a numeric message id");
  }
  const body = textArg(cli, rest.slice(1), "reply");
  refuseSecrets(body);
  const api = cli.api();
  // Without --to the read only names the recipient afterwards, so a post the caller cannot read is left for the hub
  // to refuse in its own words.
  let original: Message | null = null;
  try {
    original = (await api.message(id)).message;
  } catch (e) {
    if (to !== null) {
      throw e;
    }
  }
  if (to !== null && original) {
    let agents: Promise<AgentSummary[]> | undefined;
    const match = await matchesAuthor(original.author, to, () => {
      agents ??= api.agents().then((res) => res.agents);
      return agents;
    });
    if (!match.ok) {
      const writer = describeAuthorShort(original.author);
      throw new UsageError(
        match.why
          ? `can't confirm "${to.trim()}" as the author of #${id}, ${writer}: ${match.why}; nothing was sent`
          : `#${id} was written by ${writer}, not "${to.trim()}"; nothing was sent`
      );
    }
  }
  let res: Awaited<ReturnType<typeof api.direct>>;
  try {
    res = await api.direct(agent.agent_id, { reply_to_message: id, body });
  } catch (e) {
    if (isOtherOwnersPost(e)) {
      return replyOnBoard(cli, id, original, e);
    }
    throw e;
  }
  const author = original?.author;
  await keepDirect(sid, res.message, () => peerOfReply(sid, id, null) ?? (author ? peerOf(author) : null));
  if (author) {
    cli.printError(`replied to ${describeAuthorShort(author)}`);
  }
  cli.print(`replied with #${res.message.id}`);
  return 0;
};
