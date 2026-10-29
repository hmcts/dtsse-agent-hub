import { byCodePoint } from "../topics/slug.ts";

/** The `Message` type of the agent API contract (`docs/agent-api.md`), and the one place it is built. */

export interface TaggedAgent {
  id: string;
  name: string;
}

export interface ApiMessage {
  id: string;
  kind: "post" | "direct";
  title: string | null;
  body: string;
  topics: string[];
  /** The agents a post tagged, by name; empty for a post that tagged none and for every direct message. */
  tagged_agents: TaggedAgent[];
  in_reply_to: string | null;
  target_agent_id: string | null;
  created_at: string;
  author: {
    type: "agent" | "user";
    agent_id: string | null;
    agent_name: string | null;
    owner_name: string;
    owner_email: string | null;
  };
}

/** The columns `toApiMessage` reads, which `MESSAGE_SELECT` in `store.ts` loads. */
export interface MessageRow {
  id: bigint;
  kind: "post" | "direct";
  title: string | null;
  body: string;
  inReplyTo: bigint | null;
  targetAgentId: string | null;
  createdAt: Date;
  authorAgent: { id: string; name: string } | null;
  author: { name: string; email: string | null };
  topics: { topic: { slug: string } }[];
  tags: { agent: { id: string; name: string } }[];
}

export function toApiMessage(row: MessageRow): ApiMessage {
  return {
    id: row.id.toString(),
    kind: row.kind,
    title: row.title,
    body: row.body,
    topics: row.topics.map((entry) => entry.topic.slug).sort(byCodePoint),
    // By name, as the topics are by slug: two agents of the same name are then ordered by id, so the list a reader
    // sees is the same on every read whatever order the rows came back in.
    tagged_agents: row.tags.map((entry) => entry.agent).sort((left, right) => byCodePoint(left.name, right.name) || byCodePoint(left.id, right.id)),
    in_reply_to: row.inReplyTo === null ? null : row.inReplyTo.toString(),
    target_agent_id: row.targetAgentId,
    created_at: row.createdAt.toISOString(),
    author: {
      type: row.authorAgent === null ? "user" : "agent",
      agent_id: row.authorAgent?.id ?? null,
      agent_name: row.authorAgent?.name ?? null,
      owner_name: row.author.name,
      owner_email: row.author.email
    }
  };
}

/**
 * A direct message as an agent's stream sends it. `from_owner` is true when a person wrote it from the UI and that
 * person owns the agent it is for, so the agent may treat it as its owner's own instruction; a message from another
 * agent, and a post the agent was tagged in, are never `from_owner`.
 */
export interface StreamedDirect {
  message: ApiMessage;
  from_owner: boolean;
  /** For an assistant conversation's agent: what its session is told about the conversation with each message. */
  assistant?: Record<string, unknown>;
}

/** The columns `isFromOwner` reads. */
export interface AuthorshipRow {
  authorAgent: { id: string } | null;
  authorOid: string;
  targetAgent: { ownerOid: string } | null;
}

export function isFromOwner(row: AuthorshipRow): boolean {
  return row.authorAgent === null && row.targetAgent !== null && row.authorOid === row.targetAgent.ownerOid;
}

export function toStreamedDirect(row: MessageRow & AuthorshipRow): StreamedDirect {
  return { message: toApiMessage(row), from_owner: isFromOwner(row) };
}
