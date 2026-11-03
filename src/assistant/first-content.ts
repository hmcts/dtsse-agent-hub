import type { Database } from "../store/prisma.ts";
import { announce } from "./conversation-row.ts";

/**
 * Records that the conversations of these agents have something in them, which is what puts a conversation in the
 * sidebar's list and its search, and announces each one this write was the first to say so of, so an open sidebar
 * that left it out redraws and lists it. A conversation that already had content is neither written nor announced.
 *
 * `first_content_at` is set once and never cleared, rather than worked out from what the chat holds, because what it
 * holds does not last: transcript entries are swept after `RETENTION_DAYS`, and a chat that had only those would
 * otherwise fall back out of the list a month after the person last used it. It is what the person did in it that
 * counts, not what is still stored.
 *
 * Called in the transaction of every write by an agent that can be a chat's first content: a transcript batch with an
 * answer, a tool call or a prompt the person typed in it (`appendEntries`); a direct message to or from any of its
 * agents (`createDirect`), which is also a pod chat's first message; a question its session asked (`recordQuestion`).
 * The document write and the fork copy set the column in their own statement instead (`writeArtefact`, `acceptFork`).
 * An announcement the same transaction also makes for another reason, such as the rename a first prompt brings, goes
 * out once: Postgres folds identical notifications in one transaction into one.
 *
 * The conversations are resolved from the agents in the same statement, so a write by an agent in no conversation, or
 * in one that already has content, is one indexed read that writes nothing. They are locked in id order before they
 * are written: one direct reaches two conversations, its sender's and its recipient's, and two first directs crossing
 * between the same two sessions would otherwise each lock one row and wait on the other's. The CTE's `FOR UPDATE`,
 * which tests `first_content_at IS NULL` again once each lock is granted, is what serialises concurrent writers;
 * the same test in the update makes it safe on its own.
 */
export async function announceFirstContent(db: Database, agentIds: readonly string[]): Promise<void> {
  if (agentIds.length === 0) {
    return;
  }
  const first = await db.$queryRaw<{ id: string; virtualAgentId: string | null; ownerOid: string }[]>`
    WITH reached AS (
      SELECT id
        FROM assistant_conversation
       WHERE id IN (SELECT assistant_conversation_id FROM agent WHERE id = ANY(${[...agentIds]}::uuid[]))
         AND first_content_at IS NULL
       ORDER BY id
         FOR UPDATE
    )
    UPDATE assistant_conversation c
       SET first_content_at = now()
      FROM reached r
     WHERE c.id = r.id AND c.first_content_at IS NULL
    RETURNING c.id::text AS id, c.virtual_agent_id::text AS "virtualAgentId", c.owner_oid AS "ownerOid"
  `;
  for (const conversation of first) {
    await announce(db, conversation);
  }
}
