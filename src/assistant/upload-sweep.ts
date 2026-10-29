import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";

/**
 * The one thing that stops Postgres filling with upload bytes, and that tidies away the conversations attaching a
 * file on the new-chat screen creates and nobody sends.
 *
 * It is not a backstop: every upload's bytes leave through here, whether a pod fetched them or not. The pod's fetched
 * report marks the upload and leaves the parts, so the person can download their own file back for the rest of the
 * window (`uploadHeldUntil` in `upload-store.ts`), and this is what then takes them. Without it the database grows by
 * 25 MB an upload for ever, which is why this has a test of its own.
 *
 * Only the parts go. The metadata row stays, marked `expired`, so the thread can still say a file was attached.
 */

/** How often the sweep runs. With `UPLOAD_SWEEP_BATCH` this is the drain rate for every upload; see that constant. */
export const UPLOAD_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * How long an upload keeps its bytes in Postgres, from the moment it was started.
 *
 * Long enough for a stopped pod to be started and catch up, which is what set it, and short enough that the bytes are
 * a window rather than a store. It doubles as the window in which the owner can download their own file back, and
 * deliberately so: one clock, and no second window to reason about.
 */
export const UPLOAD_RETENTION_HOURS = 3;

/**
 * Uploads expired per sweep. Kept small because each one is up to 25 MB of part rows deleted in one transaction, and
 * all of a batch's are deleted in the same one.
 *
 * **With the interval this is the drain rate for every upload, not just for the ones nobody fetched**, since nothing
 * else deletes a part row any more. 20 every 10 minutes is 120 uploads an hour: at 25 MB each the resident part bytes
 * settle around 9 GB of the 32 GB in `infrastructure/postgres.tf`, with up to 500 MB of dead tuples per tick for
 * autovacuum to catch up on. Sustained above 120 uploads an hour the backlog grows without bound and bytes outlive
 * their window, so this and the interval are what to raise first — before the per-file or per-conversation caps, which
 * bound one person's share and say nothing about the whole database's.
 */
export const UPLOAD_SWEEP_BATCH = 20;

/** "upldswep". Distinct from the migration, offline-sweep and transcript-sweep locks. */
const UPLOAD_SWEEP_LOCK_KEY = 0x75706c64_73776570n;

export interface UploadSweepOptions {
  retentionHours?: number;
  batch?: number;
}

export interface UploadSweepResult {
  /** Uploads marked `expired`. */
  expired: number;
  /** Part rows deleted with them. */
  parts: number;
  /** Conversations deleted because attaching a file was the only thing that ever happened in them. */
  conversations: number;
}

/**
 * Deletes the parts of a batch of the uploads older than `retentionHours`, and marks those uploads `expired`. Nothing
 * is announced: a page showing the chip keeps it, which is right — the file was attached, and the chip works out for
 * itself when the window closes.
 *
 * Every state that still has bytes is taken on the one clock: still arriving, finished and waiting for a pod, and
 * already on the pod's disk. The bytes are what the window bounds and they cost the same 25 MB whichever it is, so a
 * `fetched` upload is swept at the same instant a `pending` one is rather than being kept for as long as the thread
 * shows it. What the expiry must not be is silent, and that is two other things' job: `frameAttachments` still names
 * an `expired` upload, so a pod's fetch fails and the envelope tells the session the file could not be retrieved; and
 * the thread's chip stops offering a download the moment the window closes.
 *
 * The same transaction-scoped `pg_try_advisory_xact_lock` as the other sweeps, so one pod sweeps per tick.
 * `undefined` means another pod held the lock.
 */
export async function sweepUploads(prisma: PrismaClient, options: UploadSweepOptions = {}): Promise<UploadSweepResult | undefined> {
  const { retentionHours = UPLOAD_RETENTION_HOURS, batch = UPLOAD_SWEEP_BATCH } = options;
  return await prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${UPLOAD_SWEEP_LOCK_KEY}) AS locked`;
    if (lock?.locked !== true) {
      return undefined;
    }
    const stale = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id
        FROM assistant_upload
       WHERE state IN ('pending', 'stored', 'fetched')
         AND created_at < now() - make_interval(hours => ${retentionHours}::int)
       ORDER BY created_at
       LIMIT ${batch}::int
    `;
    const ids = stale.map((row) => row.id);
    let expired = 0;
    let parts = 0;
    if (ids.length > 0) {
      parts = (await tx.assistantUploadPart.deleteMany({ where: { uploadId: { in: ids } } })).count;
      expired = (await tx.assistantUpload.updateMany({ where: { id: { in: ids } }, data: { state: "expired", updatedAt: new Date() } })).count;
    }
    return { expired, parts, conversations: await dropAbandoned(tx, retentionHours, batch) };
  });
}

/**
 * Deletes the conversations that exist only because someone attached a file on the new-chat screen and never sent it.
 *
 * Attaching there has to create the conversation first — a file belongs to one before any of its bytes can be sent —
 * so walking away at that point leaves an empty chat behind. It is not harmless: the sidebar shows it as a second
 * "New chat" the person did not make and cannot account for, and it carries a pre-created `agent` row with it. So it
 * is swept rather than left.
 *
 * The conditions are what make this safe to run unattended, and each is load-bearing:
 *
 * - **No message to or from any of its agents.** One message and the conversation is the person's; this never
 *   touches a chat that was spoken in, whatever became of its files.
 * - **No document.** The session may have written one before the person said anything.
 * - **Not a fork.** A copy of someone else's chat holds its words before anyone says anything in it, and the
 *   recipient chose to take it.
 * - **It was created longer ago than the retention window, and holds no upload newer than it.** The window follows
 *   the last thing the person actually did in the conversation rather than only when it was made, so attaching a
 *   second file hours later puts the clock back rather than leaving a live composer to be swept out from under them.
 *
 * It deliberately does **not** require the conversation to still have an upload. Attaching a file and then removing
 * the chip deletes the upload row and leaves a conversation nothing would ever collect, showing in the sidebar as a
 * "New chat" that cannot be explained; the same is true of a `startConversation` whose first message failed after
 * the row was created. An empty conversation is one nobody has said anything in, whatever route produced it, and
 * after the window it is rubbish either way.
 */
async function dropAbandoned(tx: Database, retentionHours: number, batch: number): Promise<number> {
  // `virtual_agent_id` is null for a conversation that is a local session; the announcement below carries that
  // through. Declared here because a raw query's row type is asserted rather than checked, so the compiler cannot
  // find this site the way it finds the ones reading `ConversationRow`.
  const abandoned = await tx.$queryRaw<{ id: string; virtual_agent_id: string | null; owner_oid: string }[]>`
    SELECT c.id::text AS id, c.virtual_agent_id::text AS virtual_agent_id, c.owner_oid
      FROM assistant_conversation c
     WHERE c.artefact_version = 0
       AND c.forked_at IS NULL
       AND c.created_at < now() - make_interval(hours => ${retentionHours}::int)
       AND NOT EXISTS (
             SELECT 1 FROM assistant_upload u
              WHERE u.conversation_id = c.id
                AND u.created_at >= now() - make_interval(hours => ${retentionHours}::int)
           )
       AND NOT EXISTS (
             SELECT 1 FROM message m
              WHERE m.target_agent_id IN (SELECT id FROM agent WHERE assistant_conversation_id = c.id)
                 OR m.author_agent_id IN (SELECT id FROM agent WHERE assistant_conversation_id = c.id)
           )
     ORDER BY c.created_at
     LIMIT ${batch}::int
  `;
  for (const row of abandoned) {
    await tx.assistantConversation.delete({ where: { id: row.id } });
    // Announced like any other change to it, so a sidebar still open stops showing a chat that has gone.
    await notify(tx, { type: "assistant_conversation", conversation_id: row.id, virtual_agent_id: row.virtual_agent_id, owner_oid: row.owner_oid });
  }
  return abandoned.length;
}

export interface UploadSweeper {
  stop: () => void;
}

/**
 * Runs `sweepUploads` on an interval, with the timer unreferenced as the other sweeps' are. Started unconditionally: part rows
 * hold bytes whether or not anyone is attaching anything right now.
 */
export function startUploadSweep(prisma: PrismaClient, intervalMs: number = UPLOAD_SWEEP_INTERVAL_MS): UploadSweeper {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    sweepUploads(prisma)
      .then((result) => {
        if (result !== undefined && result.expired > 0) {
          console.info(`upload sweep: ${result.expired} uploads past their window expired, ${result.parts} part rows deleted`);
        }
        if (result !== undefined && result.conversations > 0) {
          console.info(`upload sweep: ${result.conversations} conversations deleted, having only ever held an attachment nobody sent`);
        }
      })
      .catch((error: unknown) => {
        console.warn(`the upload sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
