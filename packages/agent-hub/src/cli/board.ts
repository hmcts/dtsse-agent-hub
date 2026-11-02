// The topic boards: subscriptions, reading, posting, and the JSON the chat window draws.
import { loadAgent } from "../agent.ts";
import type { Api } from "../api.ts";
import { type DirectEntry, readDirects } from "../directs.ts";
import { formatMessage } from "../envelope.ts";
import { MAX_POST_TOPICS } from "../limits.ts";
import { isEnabled, requireSessionId } from "../session.ts";
import type { Message, PostBody } from "../wire.ts";
import { type Cli, type Command, errorMessage, parseFlags, refuseSecrets, requireAgent, topicsOrDie, UsageError } from "./command.ts";

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

/**
 * Prints messages as `read` shows them, each agent author with its id and whether it is one of the caller's own: what
 * a reader needs to tag it, or to know a private reply would be refused. Without the caller's list, only the id.
 */
async function printMessages(cli: Cli, api: Api, messages: Message[]): Promise<void> {
  if (!messages.length) {
    cli.print("(no messages)");
    return;
  }
  const byAgent = messages.some((m) => m.author?.type === "agent");
  const ownAgentIds = byAgent
    ? await api.agents().then(
        (res) => new Set(res.agents.map((a) => a.id)),
        () => null
      )
    : null;
  cli.print(messages.map((m) => formatMessage(m, { ownAgentIds })).join("\n\n"));
}

export const subscribe: Command = async (cli, args) => {
  const agent = requireAgent(requireSessionId(cli.env));
  const res = await cli.api().subscribe(agent.agent_id, topicsOrDie(args));
  cli.print(`subscribed topics: ${res.topics.join(", ")}`);
  return 0;
};

export const unsubscribe: Command = async (cli, args) => {
  const agent = requireAgent(requireSessionId(cli.env));
  const res = await cli.api().unsubscribe(agent.agent_id, topicsOrDie(args));
  cli.print(`subscribed topics: ${res.topics.join(", ") || "(none)"}`);
  return 0;
};

export const topics: Command = async (cli, args) => {
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

export const read: Command = async (cli, argv) => {
  const { flags, rest } = parseFlags(argv, ["since", "limit"]);
  const api = cli.api();
  if (rest.length && rest.every((a) => /^#?\d+$/.test(a))) {
    const messages: Message[] = [];
    for (const id of rest) {
      messages.push((await api.message(id.replace(/^#/, ""))).message);
    }
    await printMessages(cli, api, messages);
    return 0;
  }
  const limit = Math.max(1, Math.min(100, Number(flags.limit) || 20));
  if (rest.length) {
    await printMessages(cli, api, await topicPosts(api, topicsOrDie(rest), { since: flags.since, limit }));
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
  await printMessages(cli, api, matches);
  return 0;
};

export const post: Command = async (cli, argv) => {
  const { flags, rest } = parseFlags(argv, ["topics", "title", "body", "reply-to", "tag"]);
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
  // An agent is written `@name` wherever the hub shows one, so a leading "@" is dropped here as `send` drops it.
  const tagged = [
    ...new Set(
      (flags.tag ?? "")
        .split(",")
        .map((entry) => entry.trim().replace(/^@/, "").trim())
        .filter((entry) => entry !== "")
    )
  ];
  if (tagged.length) {
    payload.tag_agents = tagged;
  }
  const res = await cli.api().post(agent.agent_id, payload);
  const to = tagged.length ? `${topicList.join(", ")}, tagging ${tagged.map((entry) => `@${entry}`).join(", ")}` : topicList.join(", ");
  cli.print(`posted #${res.message.id} to ${to}`);
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

export const chat: Command = async (cli, argv) => {
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

export const directory: Command = async (cli) => {
  const api = cli.api();
  const [topicList, agentList] = await Promise.all([api.topics({ limit: 200 }), api.agents()]);
  cli.print(JSON.stringify({ topics: topicList.topics, agents: agentList.agents }));
  return 0;
};

export const agents: Command = async (cli) => {
  const res = await cli.api().agents();
  if (!res.agents.length) {
    cli.print("(no agents)");
    return 0;
  }
  for (const a of res.agents) {
    const where = [a.repo, a.branch].filter(Boolean).join("@");
    cli.print(`${a.id}  @${a.name}  ${a.status}  ${where}`.trimEnd());
  }
  return 0;
};
