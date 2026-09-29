import { byCodePoint } from "../topics/slug.ts";

/** The `Message` type of the agent API contract (`docs/agent-api.md`), and the one place it is built. */

export interface ApiMessage {
  id: string;
  kind: "post" | "direct";
  title: string | null;
  body: string;
  topics: string[];
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
}

export function toApiMessage(row: MessageRow): ApiMessage {
  return {
    id: row.id.toString(),
    kind: row.kind,
    title: row.title,
    body: row.body,
    topics: row.topics.map((entry) => entry.topic.slug).sort(byCodePoint),
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
