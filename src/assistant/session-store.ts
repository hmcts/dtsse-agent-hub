import { clientSupports } from "../agents/client-features.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { findVirtualAgent, setDesired } from "../virtual-agents/store.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";
import { readAssistantModel } from "./model-store.ts";
import { hasPod } from "./pods.ts";
import type { SessionsReport } from "./schemas.ts";

const MAX_STOP_HISTORY = 50;

/**
 * Marks the conversation as needing a session, and starts its assistant if it is stopped. A wake already pending
 * keeps its time, so the sessions stream replays wakes in the order they were asked for.
 *
 * Nothing at all for a conversation with no pod, and the column is left null rather than written and left for
 * something to clear. A wake is an instruction to a pod's supervisor — `pendingWakes` selects on the virtual agent,
 * so no stream carries one for a conversation that has none — and nothing clears it either: `linkLocalSession`
 * deliberately does not, because a laptop registering is not a supervisor reporting it started what the hub asked
 * for, and `reportSessions` only ever sees a pod's own conversations. So a wake recorded here would be a row that
 * said a session had been asked for, for ever, with nobody having been asked and nothing able to answer.
 */
export async function requestWake(prisma: PrismaClient, conversation: ConversationRow, now: Date = new Date()): Promise<void> {
  if (!hasPod(conversation)) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE assistant_conversation
         SET wake_requested_at = COALESCE(wake_requested_at, ${now}), last_active_at = ${now}, updated_at = ${now}
       WHERE id = ${conversation.id}::uuid
    `;
    await announce(tx, conversation);
  });
  const assistant = await findVirtualAgent(prisma, conversation.virtualAgentId);
  if (assistant?.desired === "stopped") {
    await setDesired(prisma, conversation.ownerOid, assistant.id, "running", now);
  }
}

/** Why a stop did nothing, or `stopped` when it did. Each one is something to tell the person, not an error. */
export type StopOutcome = "stopped" | "nothing-running" | "unsupported-client";

/**
 * Stops the answer the conversation's session is working on: records it on the conversation, so the thread shows
 * where the answer was cut off, and tells the pod to interrupt the session.
 *
 * Only while the hub can see a turn to stop. The `interrupt` is sent once and never replayed, so a stop asked for
 * after the answer landed would reach a session that had moved on — and recording one that interrupted nothing would
 * put a line in the thread saying the person stopped an answer that in fact finished. `busy` on the conversation's
 * current agent is that check: the session's own hooks write it, and the bridge sends it on within seconds of a turn
 * starting or ending.
 *
 * Refused outright for a session whose client never claimed `stop`, which would ignore the frame in silence. That
 * claim is also what the UI gates its stop control on, so this is the second line of the same defence rather than
 * the one the person normally meets.
 *
 * `nothing-running` for a conversation with no pod, for the same reason as one with no agent: the stop is an
 * `assistant_stop` to the conversation's pod, and there is no pod to send it to.
 */
export async function stopAnswer(prisma: PrismaClient, conversation: ConversationRow, now: Date = new Date()): Promise<StopOutcome> {
  if (!hasPod(conversation) || conversation.agentId === null) {
    return "nothing-running";
  }
  const agent = await prisma.agent.findUnique({ where: { id: conversation.agentId }, select: { status: true, clientFeatures: true } });
  if (agent === null || agent.status !== "busy") {
    return "nothing-running";
  }
  if (!clientSupports(agent.clientFeatures, "stop")) {
    return "unsupported-client";
  }
  const history = [...conversation.stopHistory, { at: now.toISOString() }].slice(-MAX_STOP_HISTORY);
  await prisma.$transaction(async (tx) => {
    // Written as `setProduct` writes the product history, rather than through the typed client: Prisma's JSON input
    // type takes no array of a named interface, and the two histories are better off written the same way.
    await tx.$executeRaw`
      UPDATE assistant_conversation
         SET stop_history = ${JSON.stringify(history)}::jsonb, updated_at = ${now}
       WHERE id = ${conversation.id}::uuid
    `;
    // The pod acts on `assistant_stop`; the announcement beside it is what redraws the thread for the person.
    await announce(tx, conversation);
    await notify(tx, {
      type: "assistant_stop",
      conversation_id: conversation.id,
      virtual_agent_id: conversation.virtualAgentId,
      owner_oid: conversation.ownerOid
    });
  });
  return "stopped";
}

/**
 * A session registered for the conversation: its agent becomes the conversation's current one, the wake is
 * answered, and the session counts as activity for the assistant's idle stop. Called inside the registration's
 * transaction, which has already checked that the conversation is the registering virtual agent's.
 */
export async function linkSession(
  db: Database,
  session: { conversationId: string; virtualAgentId: string; ownerOid: string; agentId: string },
  now: Date = new Date()
): Promise<void> {
  await db.assistantConversation.update({
    where: { id: session.conversationId },
    data: { agentId: session.agentId, wakeRequestedAt: null, sessionState: "live", sessionDetail: null, updatedAt: now }
  });
  await db.virtualAgent.update({ where: { id: session.virtualAgentId }, data: { lastActiveAt: now, updatedAt: now } });
  await announce(db, { id: session.conversationId, virtualAgentId: session.virtualAgentId, ownerOid: session.ownerOid });
}

/**
 * What the pod's supervisor runs, replacing its last report: every conversation of the assistant it leaves out has
 * no session. Only conversations whose state changed are announced. Not activity for the idle stop, which a pod
 * reporting every minute would otherwise never reach.
 *
 * A session reported `live` answers the conversation's wake, as a registration does. A registration cannot be
 * relied on for that: a conversation resumed on a new pod never registers again, because its session finds the
 * `enabled` file the pod before it left on the volume and skips the enable that would have. Left pending, its wake
 * is replayed on every sessions stream the pod opens, and `fill()` takes the oldest wake first — so a handful of
 * resumed conversations take each other's slots in turn for ever and no one of them keeps a session long enough to
 * answer. Nothing is stranded by clearing it: a pod that loses its sessions leaves their agents silent, and the
 * offline sweep is what the person's next message and the warm on opening a conversation ask for a wake on.
 *
 * The report's `max` is kept as well, because it is the only account of what the pod in front of the person actually
 * enforces: the cap is in the pod template, so raising the constant reaches a running pod when it next rolls and the
 * two disagree until then. `chatCapacity` is what reads it, and gives no current figure at all when it is null or
 * the pod has stopped. Written on every report rather than only when it changes — it is one integer on a row this
 * already touches, and a pod that rolled onto a new cap says so with its first report rather than waiting for a
 * session to start or stop.
 */
export async function reportSessions(prisma: PrismaClient, virtualAgentId: string, report: SessionsReport, now: Date = new Date()): Promise<void> {
  const reported = new Map(report.sessions.map((session) => [session.conversation_id, session]));
  await prisma.$transaction(async (tx) => {
    await tx.virtualAgent.updateMany({ where: { id: virtualAgentId }, data: { sessionsMax: report.max, updatedAt: now } });
    const rows = await tx.assistantConversation.findMany({
      where: { virtualAgentId },
      select: { id: true, ownerOid: true, virtualAgentId: true, sessionState: true, sessionDetail: true, wakeRequestedAt: true }
    });
    for (const row of rows) {
      const session = reported.get(row.id);
      const state = session?.state ?? null;
      const detail = session?.detail ?? null;
      // Only `live`, not `starting`: a session still starting may yet fail, and its wake is what starts it again.
      const woken = state === "live" && row.wakeRequestedAt !== null;
      if (row.sessionState !== state || row.sessionDetail !== detail || woken) {
        await tx.assistantConversation.update({
          where: { id: row.id },
          data: { sessionState: state, sessionDetail: detail, ...(woken ? { wakeRequestedAt: null } : {}), updatedAt: now }
        });
        await announce(tx, row);
      }
    }
  });
}

/** A wake on the sessions stream: the conversation needs a session, under this session id. */
export interface Wake {
  conversation_id: string;
  session_id: string;
  resume: boolean;
  product: string;
  /** The model to start the session on, which the pod passes to its launcher as `--model`. */
  model: string;
}

/**
 * Every pending wake of the assistant, oldest first. `resume` once the session has sent a transcript entry. The
 * product is the stored one, as the frame's is: what the pod is told is what the conversation holds. The model is
 * the owner's one choice, as the frame's is, so every session the pod starts runs on what they picked.
 */
export async function pendingWakes(db: Database, virtualAgentId: string): Promise<Wake[]> {
  const rows = await db.$queryRaw<(Omit<Wake, "model"> & { owner_oid: string })[]>`
    SELECT c.id::text AS conversation_id, a.session_id, EXISTS (SELECT 1 FROM transcript_entry t WHERE t.agent_id = a.id) AS resume, c.product, c.owner_oid
      FROM assistant_conversation c
      JOIN agent a ON a.id = c.agent_id
     WHERE c.virtual_agent_id = ${virtualAgentId}::uuid AND c.wake_requested_at IS NOT NULL
     ORDER BY c.wake_requested_at, c.id
  `;
  const owner = rows[0]?.owner_oid;
  if (owner === undefined) {
    return [];
  }
  // Every conversation on a virtual agent is its owner's, so one read answers for all of these rows.
  const model = await readAssistantModel(db, owner);
  return rows.map(({ owner_oid: _owner, ...wake }) => ({ ...wake, model }));
}

/** The wake for one conversation, if it has one pending; `null` when the conversation is gone. */
export async function pendingWake(db: Database, virtualAgentId: string, conversationId: string): Promise<Wake | undefined | null> {
  const exists = await db.assistantConversation.count({ where: { id: conversationId, virtualAgentId } });
  if (exists === 0) {
    return null;
  }
  const wakes = await pendingWakes(db, virtualAgentId);
  return wakes.find((wake) => wake.conversation_id === conversationId);
}
