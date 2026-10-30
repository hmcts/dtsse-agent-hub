import type { AgentRef } from "../access/rules.ts";
import type { AgentRow } from "../agents/store.ts";
import { refreshLocalTitle } from "../assistant/store.ts";
import { firstPromptTitle } from "../assistant/titles.ts";
import { notify } from "../realtime/notify.ts";
import type { PrismaClient } from "../store/prisma.ts";
import type { NewTranscriptEntry } from "./schema.ts";

/** What storing a batch needs of the agent it belongs to, all of it already read by `ownedAgentRoute`. */
type UploadAgent = AgentRef & Pick<AgentRow, "localConversation">;

/**
 * Whether anything in this batch could name a chat: asked of `firstPromptTitle`, the rule the derivation itself
 * uses, so the two cannot come to disagree about what counts as a prompt. A redacted entry holds the pattern the
 * secret scanner matched and none of the words; a relayed hub message (`message_id`) is somebody else's words
 * delivered into the session; and whitespace is not a title.
 *
 * `message_id` here is what the client claimed, where `firstPromptTitle` reads what was stored — an id naming
 * anything other than a direct message to this agent is stored as null. So a prompt wrongly claiming to be relayed
 * is passed over by this gate and still names the chat on the next batch that carries one.
 *
 * This gates `refreshLocalTitle`'s other derivation too, so a `/rename` the session reported is followed on the
 * person's next prompt rather than on the next hub message relayed into their session. The rename itself is on the
 * agent row the moment its heartbeat lands; it is only the chat's title that waits for them to type.
 */
function carriesPrompt(entries: readonly NewTranscriptEntry[]): boolean {
  const prompts = entries
    .filter((entry) => entry.role === "user")
    .map((entry) => ({ content: entry.content, redacted: entry.redacted, messageId: entry.message_id }));
  return firstPromptTitle(prompts) !== null;
}

/**
 * Stores a batch of an agent's transcript and returns how many entries were new. An entry whose key the agent has
 * already sent is skipped, so a client may resend a batch it is unsure arrived.
 *
 * `message_id` is kept only when it names a direct message to this agent; anything else, another agent's message,
 * a post or an id that does not exist, is stored as `null`, so an upload cannot link itself to a thread it is not in.
 * One NOTIFY per batch, and none when nothing was new.
 *
 * A batch that brought a prompt is also where a chat on somebody's own computer gets its name, because this is the
 * one moment the hub learns what the person typed. Nothing for a batch with no prompt in it, and nothing for one
 * that was all resent: whatever a resend carried was judged when it first arrived.
 *
 * That it is such a chat is asked of `localConversation`, which costs nothing because the route has already read
 * it. Most uploads are neither: a board session has no chat at all, and a pod's chat is named after the person's
 * first message rather than after what its session read that message back as. Asking the chat instead would charge
 * every one of them a read of the agent row to be told there was nothing to do.
 */
export async function appendEntries(prisma: PrismaClient, agent: UploadAgent, sessionId: string, entries: readonly NewTranscriptEntry[]): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const [inserted] = await tx.$queryRaw<{ accepted: number; last_id: string | null }[]>`
      WITH batch AS (
        SELECT *
          FROM unnest(
            ${entries.map((entry) => entry.key)}::text[],
            ${entries.map((entry) => entry.role)}::text[],
            ${entries.map((entry) => JSON.stringify(entry.content))}::text[],
            ${entries.map((entry) => entry.truncated)}::boolean[],
            ${entries.map((entry) => entry.redacted)}::boolean[],
            ${entries.map((entry) => entry.message_id?.toString() ?? null)}::text[],
            ${entries.map((entry) => entry.occurred_at.toISOString())}::text[]
          ) WITH ORDINALITY AS e(entry_key, role, content, truncated, redacted, message_id, occurred_at, position)
      ),
      inserted AS (
        INSERT INTO transcript_entry (agent_id, session_id, entry_key, role, content, truncated, redacted, message_id, occurred_at)
        SELECT ${agent.id}::uuid, ${sessionId}, b.entry_key, b.role::transcript_role, b.content::jsonb, b.truncated, b.redacted, m.id,
               b.occurred_at::timestamptz
          FROM batch b
          LEFT JOIN message m ON m.id = b.message_id::bigint AND m.kind = 'direct' AND m.target_agent_id = ${agent.id}::uuid
         ORDER BY b.position
        ON CONFLICT (agent_id, entry_key) DO NOTHING
        RETURNING id
      )
      SELECT count(*)::int AS accepted, max(id)::text AS last_id FROM inserted
    `;
    const accepted = inserted?.accepted ?? 0;
    if (accepted > 0 && inserted?.last_id) {
      await notify(tx, { type: "transcript", agent_id: agent.id, owner_oid: agent.ownerOid, last_id: inserted.last_id });
    }
    if (accepted > 0 && agent.localConversation && carriesPrompt(entries)) {
      await refreshLocalTitle(tx, agent.id);
    }
    return accepted;
  });
}
