// Direct messages between a person's own agents, and the advice that points anything else at the board.
import { ApiError } from "../api.ts";
import { type DirectPeer, peerOf, peerOfReply, recordDirect } from "../directs.ts";
import { authorAgentTag, boardAnswerCommand, CLI, describeAuthorShort, plainText, SHORT_ID_LENGTH } from "../envelope.ts";
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

const MISPLACED_TO = "put --to before the message, and quote the message text if it ends with --to";

const isToFlag = (arg: string | undefined) => arg === "--to" || !!arg?.startsWith("--to=");

/**
 * The `--to` and its value, wherever they come before the message text, and what is left. The text starts at the
 * argument after the id. A `--to` that ends the text is refused rather than sent as words, since it reads as the
 * check the caller asked for and sending would skip it; a `--to` anywhere else in the text is a word like any other.
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
    if (!to.trim()) {
      throw new UsageError("--to needs a value");
    }
  }
  const text = args.slice(i);
  if (isToFlag(text.at(-1)) || text.at(-2) === "--to") {
    throw new UsageError(MISPLACED_TO);
  }
  return { to, rest: [...rest, ...text] };
}

const same = (text: string | null | undefined) => plainText(text).toLowerCase();

/**
 * What a `--to` says, split the way an author is written, so an author copied from a note, an error or a message's
 * header matches: `@name [agent 1a2b3c4d]`, `agent @name (owned by …)`, `Name <email>`, `<email>`, or a bare name,
 * email or id. Any trailing `(…)` is dropped, whatever its wording: `plainText` keeps parentheses out of every name.
 */
function parseTo(to: string): { text: string; email: string | null; idPrefix: string | null } {
  let rest = to.trim();
  while (/\([^()]*\)\s*$/.test(rest)) {
    rest = rest.replace(/\s*\([^()]*\)\s*$/, "");
  }
  rest = rest.replace(/^agent\s+(?=@)/i, "");
  const email = /<([^<>\s]+)>\s*$/.exec(rest);
  if (email) {
    return { text: "", email: (email[1] as string).toLowerCase(), idPrefix: null };
  }
  const tag = /\s*\[agent ([^\]\s]+)\]\s*$/i.exec(rest);
  const idPrefix = tag ? (tag[1] as string).toLowerCase() : null;
  const text = same((tag ? rest.slice(0, tag.index) : rest).replace(/^@/, ""));
  return { text, email: text.includes("@") ? text : null, idPrefix };
}

type Match = { ok: true } | { ok: false; why?: string };
const MATCH: Match = { ok: true };
const NO_MATCH: Match = { ok: false };

const isPersonLike = (author: MessageAuthor) => author.type !== "agent" || !plainText(author.agent_name);

/**
 * Whether `to` names the author. A person, or an agent with no name, which is shown as a person, by email, since two
 * people can share a name; by name only when they have no email to give. An agent by its id, exact or as a prefix of at least `SHORT_ID_LENGTH` characters that
 * none of the caller's other agents shares; or by its name (case-insensitive) only when it is one of the caller's own
 * agents and no other of theirs shares the name, since another owner's agent may carry the same name. A `why` is a
 * refusal that needs more than "not the author" to explain.
 */
async function matchesAuthor(author: MessageAuthor, to: string, ownAgents: () => Promise<AgentSummary[]>): Promise<Match> {
  const wanted = parseTo(to);
  if (isPersonLike(author)) {
    if (wanted.email) {
      return wanted.email === same(author.owner_email) ? MATCH : NO_MATCH;
    }
    if (!wanted.text || wanted.text !== same(author.owner_name)) {
      return NO_MATCH;
    }
    return author.owner_email ? { ok: false, why: "a person is matched by email, since names are shared" } : MATCH;
  }
  const id = (author.agent_id ?? "").toLowerCase();
  const name = same(author.agent_name);
  if (!wanted.text && wanted.idPrefix === null) {
    return NO_MATCH;
  }
  const byName = !!wanted.text && wanted.text === name;
  const prefix = wanted.idPrefix ?? (byName ? null : wanted.text);
  if (wanted.idPrefix !== null && wanted.text && !byName) {
    return NO_MATCH;
  }
  if (prefix !== null && !id.startsWith(prefix)) {
    return NO_MATCH;
  }
  if (prefix === null && !byName) {
    return NO_MATCH;
  }
  if (prefix === id) {
    return MATCH;
  }
  if (prefix !== null && prefix.length < SHORT_ID_LENGTH) {
    return { ok: false, why: `an agent id prefix needs at least ${SHORT_ID_LENGTH} characters` };
  }
  let agents: AgentSummary[];
  try {
    agents = await ownAgents();
  } catch {
    return { ok: false, why: "could not check your agents to confirm it; give the whole agent id" };
  }
  if (prefix !== null) {
    const shared = agents.some((other) => other.id.toLowerCase() !== id && other.id.toLowerCase().startsWith(prefix));
    return shared ? { ok: false, why: `"${prefix}" is also a prefix of another of your agents' ids` } : MATCH;
  }
  if (!agents.some((a) => a.id.toLowerCase() === id)) {
    return { ok: false, why: "it is not one of your own agents, and another owner's agent can share a name; give its agent id" };
  }
  return agents.filter((a) => same(a.name) === name).length > 1
    ? { ok: false, why: `more than one of your agents is called "${to.trim()}"; give the agent id or an ${SHORT_ID_LENGTH}-character prefix of it` }
    : MATCH;
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
  let unread = false;
  try {
    original = (await api.message(id)).message;
  } catch (e) {
    if (to !== null) {
      throw e;
    }
    unread = true;
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
  } else if (unread) {
    cli.printError(`replied, but #${id} could not be read, so who it went to is not confirmed`);
  }
  cli.print(`replied with #${res.message.id}`);
  return 0;
};
