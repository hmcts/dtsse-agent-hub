// Direct messages between a person's own agents, and the advice that points anything else at the board.
import type { Api } from "../api.ts";
import { ApiError } from "../api.ts";
import { type DirectPeer, peerOf, peerOfReply, recordDirect } from "../directs.ts";
import { authorAgentTag, boardAnswerCommand, CLI } from "../envelope.ts";
import { requireSessionId } from "../session.ts";
import type { Message, MessageAuthor } from "../wire.ts";
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

/** Prints the hub's refusal and the `post` that answers on the board, filled in from the post when it can be read. */
async function replyOnBoard(cli: Cli, api: Api, id: string, error: ApiError): Promise<number> {
  cli.printError(`${CLI} reply: ${error.body?.error}`);
  const original = await api.message(id).then(
    (res) => res.message,
    () => null
  );
  cli.printError("Answer on the board instead:");
  cli.printError(`  ${boardAnswerCommand({ topics: original?.topics, replyTo: id, tag: authorAgentTag(original?.author) ?? "<agent id>" })}`);
  return 1;
}

/** The shortest agent id prefix `reply --to` accepts: anything shorter could name several agents. */
export const MIN_ID_PREFIX = 8;

/** Who a reply to a post by `author` reaches, as printed before it is sent. */
export function recipientLine(author: MessageAuthor): string {
  return `→ replying to ${describeRecipient(author)}`;
}

function describeRecipient(author: MessageAuthor): string {
  if (author.type === "agent") {
    return `@${author.agent_name ?? "unknown"} (${author.agent_id ?? "no agent id"})`;
  }
  return author.owner_email ? `${author.owner_name} (${author.owner_email})` : author.owner_name;
}

/** The `--to` and its value, in front of the text or after the id, and what is left. Text after them is never read as options. */
function takeTo(args: string[]): { to: string | null; rest: string[] } {
  for (const i of [0, 1]) {
    const arg = args[i];
    if (arg === "--to") {
      const value = args[i + 1];
      if (value === undefined) {
        throw new UsageError("--to needs a value");
      }
      return { to: value, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
    }
    if (arg?.startsWith("--to=")) {
      return { to: arg.slice("--to=".length), rest: [...args.slice(0, i), ...args.slice(i + 1)] };
    }
  }
  return { to: null, rest: args };
}

/**
 * Whether `to` names the author: an agent by its name (case-insensitive, with or without the `@`) or its id, exact or
 * as a prefix of at least `MIN_ID_PREFIX` characters that none of the caller's other agents shares; a person by email.
 * A string is a refusal that needs more than "not the author" to explain.
 */
async function matchesAuthor(author: MessageAuthor, to: string, agentIds: () => Promise<string[]>): Promise<boolean | string> {
  const wanted = to.trim().toLowerCase();
  if (author.type !== "agent") {
    return !!author.owner_email && author.owner_email.toLowerCase() === wanted;
  }
  if (author.agent_name && author.agent_name.toLowerCase() === wanted.replace(/^@\s*/, "")) {
    return true;
  }
  const id = (author.agent_id ?? "").toLowerCase();
  if (!wanted || !id.startsWith(wanted)) {
    return false;
  }
  if (wanted === id) {
    return true;
  }
  if (wanted.length < MIN_ID_PREFIX) {
    return `an agent id prefix needs at least ${MIN_ID_PREFIX} characters`;
  }
  let ids: string[];
  try {
    ids = await agentIds();
  } catch {
    return "could not check that the id prefix is unambiguous; give the whole id";
  }
  const shared = ids.filter((other) => other.toLowerCase() !== id && other.toLowerCase().startsWith(wanted));
  return shared.length ? `"${to.trim()}" is also a prefix of another of your agents' ids` : true;
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
  const original = (await api.message(id)).message;
  if (to !== null) {
    const match = await matchesAuthor(original.author, to, async () => (await api.agents()).agents.map((a) => a.id));
    if (match !== true) {
      const why = typeof match === "string" ? ` (${match})` : "";
      throw new UsageError(`#${id} was written by ${describeRecipient(original.author)}, not "${to.trim()}"${why}; nothing was sent`);
    }
  }
  cli.printError(recipientLine(original.author));
  let res: Awaited<ReturnType<typeof api.direct>>;
  try {
    res = await api.direct(agent.agent_id, { reply_to_message: id, body });
  } catch (e) {
    if (isOtherOwnersPost(e)) {
      return await replyOnBoard(cli, api, id, e);
    }
    throw e;
  }
  await keepDirect(sid, res.message, () => peerOfReply(sid, id, null) ?? peerOf(original.author));
  cli.print(`replied with #${res.message.id}`);
  return 0;
};
