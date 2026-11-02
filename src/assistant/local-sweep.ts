import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce, detachLocalSessions } from "./store.ts";

/**
 * The one thing that bounds how many conversations a person's own Claude Code sessions leave in their Assistant.
 *
 * Every session that is nobody's pod and has no conversation gets one (`linkLocalSession`), when it registers or on
 * its next heartbeat, and a new session id is a new agent and so a new conversation — including every `/clear`, which mints one, at a measured
 * 500 sessions a week. The sidebar and the search leave out the ones nothing was said in (`first_content_at`), so they
 * do not crowd out the chats that matter, but nothing else removes the rows: `dropAbandoned` in
 * `upload-sweep.ts` requires a pod, because the cascade there would take the live session's agent row with the chat.
 * Left alone they would only accumulate, each with its agent's link to it.
 *
 * This collects the local conversations nothing ever happened in. The conversation is made when the hub first hears
 * from the session rather than when it first says something, because a laptop session the person wants to open a chat *with* needs
 * one before it has spoken, which is the one thing the conversation is for.
 *
 * What it must never do is cascade. `agent.assistant_conversation_id` is `ON DELETE CASCADE` and the agent's own
 * dependants cascade from there, so deleting the row under a live session would take its transcript, its deliveries,
 * its subscriptions, its questions and every direct message to or from it — including board messages with colleagues
 * that have nothing to do with the chat. `collectEmpty` therefore detaches the session first and deletes the
 * conversation second, which is the shape `deleteConversation` uses for the same reason.
 */

/** How often the sweep runs: the same tick as the transcript and upload sweeps, which is far faster than chats arrive. */
const LOCAL_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * How long an empty local conversation is kept, measured from when it was created and from when its session was last
 * heard from.
 *
 * It has to outlast a laptop, not a chat. The session's own clock is what the window really runs on: a session the
 * person is working in heartbeats every few tens of seconds, so one silent for a day has ended or the machine is off,
 * and there is nothing for the chat to be the start of. A day rather than hours because that is the longest a message
 * typed into the chat could still be delivered (`EXPIRE_AFTER_SECONDS` in `src/agents/liveness.ts`, which also
 * reasons about a laptop asleep overnight): while the hub would still hand a message over, the chat stays.
 *
 * Nothing is lost at the far end. A session that comes back after longer than this is linked a new, empty chat by its
 * next heartbeat, as any session with no conversation is. The one collected held no words, no transcript, no question
 * and no document, which is what made it collectable.
 */
export const LOCAL_CONVERSATION_RETENTION_HOURS = 24;

/**
 * Conversations collected per sweep. Each is one `UPDATE`, one `DELETE` of a single row and one NOTIFY, so this is far
 * cheaper per item than the upload sweep's batch and can be far larger: 200 every 10 minutes is 1,200 an hour, well
 * above the whole hub's arrival rate of empty chats at the measured 500 sessions a week per engineer.
 */
const LOCAL_SWEEP_BATCH = 200;

/** "lclcswep". Distinct from the migration, offline-sweep, transcript-sweep, upload-sweep and virtual-agent locks. */
const LOCAL_SWEEP_LOCK_KEY = 0x6c636c63_73776570n;

export interface LocalSweepOptions {
  retentionHours?: number;
  batch?: number;
}

export interface LocalSweepResult {
  /** Conversations collected: a local session's chat nothing ever happened in. */
  collected: number;
}

/**
 * Collects a batch of the empty local conversations past `retentionHours`, under the same transaction-scoped
 * `pg_try_advisory_xact_lock` as the other sweeps so one pod sweeps per tick. `undefined` means another pod held the
 * lock.
 */
export async function sweepLocalConversations(prisma: PrismaClient, options: LocalSweepOptions = {}): Promise<LocalSweepResult | undefined> {
  const { retentionHours = LOCAL_CONVERSATION_RETENTION_HOURS, batch = LOCAL_SWEEP_BATCH } = options;
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCAL_SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }
    return { collected: await collectEmpty(tx, retentionHours, batch) };
  });
}

/**
 * Deletes the local conversations nothing ever happened in, detaching each one's session before the row goes.
 *
 * `first_content_at` is what decides whether a chat is listed (`announceFirstContent`). It is not trusted alone to
 * decide that one may be deleted, because a writer that does not set it — a pod still running the release before the
 * column, during a rolling deploy — can have put words in a chat since the backfill ran, and deleting is the one
 * mistake that cannot be put right. So the column is checked beside the data itself, and every condition must hold:
 *
 * - **Nothing was ever recorded in it** (`first_content_at IS NULL`). This is also what keeps a chat whose transcript
 *   has been swept after `RETENTION_DAYS`: the data checks below would find nothing left, and the column remembers.
 * - **Its sessions uploaded no transcript at all.** Not only none the sidebar would count: a session that has written
 *   anything is one this sweep cannot be sure has finished with its chat, and keeping such a chat costs a row where
 *   collecting it wrongly would cost the person's work.
 * - **No direct message to or from any of its agents.** `kind = 'direct'` and not every message, unlike
 *   `dropAbandoned`'s condition: a local session's agent is an ordinary agent on the roster, and the posts it wrote to
 *   the boards are not words in this chat, while a direct is — the local thread merges directs with the transcript.
 * - **Its sessions asked no question**, which the thread shows as a card.
 * - **No document**, which the person and the session can both write.
 * - **It has no pod.** A conversation with one is the Assistant's own chat on a virtual agent, whose agent exists
 *   only to be that chat's session; `dropAbandoned` is what collects those, and the two sweeps must not both own a
 *   row.
 * - **It was created longer ago than the window, and no session of it has been heard from inside it.**
 *   `last_heartbeat_at` is the hub's own column, written on register and on every heartbeat, so it answers "is this
 *   session still running" whatever the client's clock says — the near miss `transcripts/sweep.ts` records for
 *   `occurred_at` applies here too. Without it a session registered an hour ago and idle while its owner reads would
 *   be collected out from under them.
 */
async function collectEmpty(tx: Database, retentionHours: number, batch: number): Promise<number> {
  const empty = await tx.$queryRaw<{ id: string; owner_oid: string }[]>`
    SELECT c.id::text AS id, c.owner_oid
      FROM assistant_conversation c
     WHERE c.virtual_agent_id IS NULL
       AND c.first_content_at IS NULL
       AND c.artefact_version = 0
       AND c.created_at < now() - make_interval(hours => ${retentionHours}::int)
       AND NOT EXISTS (
             SELECT 1 FROM agent a
              WHERE a.assistant_conversation_id = c.id
                AND a.last_heartbeat_at >= now() - make_interval(hours => ${retentionHours}::int)
           )
       -- Each of these drives from agent and joins out to the dependant, rather than asking the dependant whose
       -- agent it is: that way every step is an index scan — agent_assistant_conversation_id_idx, then
       -- transcript_entry_agent_id_id_idx, agent_question_agent_idx, message_direct_target_idx and
       -- message_author_agent_idx. Written the other way round, as t.agent_id IN (SELECT ...), the planner reads the
       -- whole of transcript_entry per candidate, which is the hub's largest table.
       AND NOT EXISTS (
             SELECT 1 FROM agent a JOIN transcript_entry t ON t.agent_id = a.id
              WHERE a.assistant_conversation_id = c.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM agent a JOIN agent_question q ON q.agent_id = a.id
              WHERE a.assistant_conversation_id = c.id
           )
       -- What it received and what it sent, as two clauses rather than one OR across the two columns: each has its
       -- own index, and an OR inside the join condition is a filter the planner cannot answer from either.
       AND NOT EXISTS (
             SELECT 1 FROM agent a JOIN message m ON m.kind = 'direct' AND m.target_agent_id = a.id
              WHERE a.assistant_conversation_id = c.id
           )
       AND NOT EXISTS (
             SELECT 1 FROM agent a JOIN message m ON m.kind = 'direct' AND m.author_agent_id = a.id
              WHERE a.assistant_conversation_id = c.id
           )
     ORDER BY c.created_at
     LIMIT ${batch}::int
     -- Skipped while the person is deleting it: deleteConversation holds the row lock, and the chat is theirs to
     -- finish. A delete that finds this sweep holding it waits, and marks the sessions this detached.
       FOR UPDATE OF c SKIP LOCKED
  `;
  for (const row of empty) {
    // The detach, before the delete and inside the same transaction, is the whole of why this is safe to run
    // unattended: it clears the cascading column, so the row that goes next takes nothing of the session with it.
    // Not as the person removing it: they removed nothing, so a session that comes back and says something is given
    // a chat again.
    await detachLocalSessions(tx, row.id, { removedByPerson: false });
    await tx.assistantConversation.delete({ where: { id: row.id } });
    // Announced like any other change to it, so a sidebar still open stops showing a chat that has gone. A local
    // conversation's `virtual_agent_id` is null by definition, which is what `ui-stream` selects this frame past.
    await announce(tx, { id: row.id, virtualAgentId: null, ownerOid: row.owner_oid });
  }
  return empty.length;
}

export interface LocalSweeper {
  stop: () => Promise<void>;
}

/**
 * Runs `sweepLocalConversations` on an interval, with the timer unreferenced as the other sweeps' are. Started
 * unconditionally: a laptop session registers whether or not virtual agents are on, so the rows arrive either way.
 */
export function startLocalConversationSweep(prisma: PrismaClient, intervalMs: number = LOCAL_SWEEP_INTERVAL_MS): LocalSweeper {
  let running = false;
  let tick: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    tick = sweepLocalConversations(prisma)
      .then((result) => {
        if (result !== undefined && result.collected > 0) {
          console.info(`local chat sweep: ${result.collected} chats on people's own computers deleted, nothing having ever happened in them`);
        }
      })
      .catch((error: unknown) => {
        console.warn(`the local chat sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  // Waits for the tick in flight as the other sweeps' `stop` does, and for the same reason: its transaction is still
  // holding locks on `agent` and `assistant_conversation` that the caller's next statement may want.
  return {
    stop: async () => {
      clearInterval(timer);
      await tick;
    }
  };
}
