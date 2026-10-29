import type { AgentRef } from "../access/rules.ts";
import { refreshLocalTitle } from "../assistant/store.ts";
import { notify } from "../realtime/notify.ts";
import type { PrismaClient } from "../store/prisma.ts";
import type { NewTranscriptEntry } from "./schema.ts";

/** A prompt this batch could name a chat after: something the person typed, with its words still in it. */
function carriesPrompt(entries: readonly NewTranscriptEntry[]): boolean {
  return entries.some((entry) => entry.role === "user" && !entry.redacted);
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
 */
export async function appendEntries(prisma: PrismaClient, agent: AgentRef, sessionId: string, entries: readonly NewTranscriptEntry[]): Promise<number> {
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
    if (accepted > 0 && carriesPrompt(entries)) {
      await refreshLocalTitle(tx, agent.id);
    }
    return accepted;
  });
}
