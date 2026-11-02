import type { AgentRef } from "../access/rules.ts";
import { announceFirstContent, refreshLocalTitle } from "../assistant/store.ts";
import { shownInThread } from "../assistant/thread.ts";
import { firstPromptTitle, type PromptEntry } from "../assistant/titles.ts";
import { notify } from "../realtime/notify.ts";
import type { PrismaClient } from "../store/prisma.ts";
import type { NewTranscriptEntry } from "./schema.ts";

/** What storing a batch needs of the agent it belongs to, all of it already read by `ownedAgentRoute`. */
type UploadAgent = AgentRef;

/**
 * What a batch holds that a local chat cares about.
 *
 * - **`prompt`**: something that could name the chat, which is what `refreshLocalTitle` is called for. Asked of
 *   `firstPromptTitle`, the rule the derivation itself uses, so the two cannot come to disagree about what counts as
 *   a prompt. A redacted entry holds the pattern the secret scanner matched and none of the words; a relayed hub
 *   message (`message_id`) is somebody else's words delivered into the session; and whitespace or the harness's own
 *   turn is not a title. This gates `refreshLocalTitle`'s other derivation too, so a `/rename` the session reported is
 *   followed on the person's next prompt rather than on the next hub message relayed into their session. The rename
 *   itself is on the agent row the moment its heartbeat lands; it is only the chat's title that waits for them to type.
 * - **`content`**: something the chat's thread would show other than a notice (`shownInThread`, the thread's own
 *   rule), which is what makes the batch its first content (`announceFirstContent`): an answer with words in it, a
 *   tool call, or a user turn shown as a bubble. Not a batch of nothing but `/clear`'s record and editor context,
 *   which costs the upload nothing. Relayed or not is not asked: a relayed prompt is in a chat that already has the
 *   message it relays.
 *
 * `message_id` here is what the client claimed, where `firstPromptTitle` reads what was stored — an id naming
 * anything other than a direct message to this agent is stored as null. So a prompt wrongly claiming to be relayed
 * is passed over by this gate and still names the chat on the next batch that carries one.
 */
function whatItCarries(entries: readonly NewTranscriptEntry[]): { prompt: boolean; content: boolean } {
  const prompts: PromptEntry[] = [];
  let content = false;
  for (const entry of entries) {
    if (entry.role === "user") {
      prompts.push({ content: entry.content, redacted: entry.redacted, messageId: entry.message_id });
    }
    content ||= shownInThread(entry);
  }
  return { prompt: firstPromptTitle(prompts) !== null, content };
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
 * The same batch can be what puts a chat in its owner's sidebar, which leaves out a chat with nothing in it: a batch
 * that brought content records its agent's conversation's first content, and the chat is announced when that is the
 * first time, so an open sidebar redraws and lists it; naming the chat in the same transaction announces it again,
 * which Postgres delivers once.
 *
 * What that costs every upload, whoever sent it: one indexed update for a batch that carries content, which writes
 * nothing for a board session with no chat or a chat that already has content, and `refreshLocalTitle`'s read of the
 * agent for a batch that carries a prompt, which does nothing for a chat on a pod or one the person renamed. Neither
 * is skipped on what the route read of the agent, because a heartbeat can link the session's chat between that read
 * and this transaction, and a skipped write is a chat that stays out of the sidebar or keeps the session's name.
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
    if (accepted === 0) {
      return accepted;
    }
    const carried = whatItCarries(entries);
    if (carried.content) {
      await announceFirstContent(tx, [agent.id]);
    }
    if (carried.prompt) {
      await refreshLocalTitle(tx, agent.id);
    }
    return accepted;
  });
}
