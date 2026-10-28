import { HttpError } from "../agent-api/http.ts";
import type { AgentRow } from "../agents/store.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { offerExpired, type QuestionPost, type QuestionSetAnswer } from "./questions.ts";

/**
 * A question as the hub keeps it: recorded when a session's `PreToolUse` hook intercepts `AskUserQuestion`, read by
 * the pages that show the chat, and answered when the person picks — in the same transaction as the message their
 * answer is sent as, so a card never claims an answer that was not delivered and no answer is delivered twice.
 */

/** Tells every pod's UI stream that `agent`'s questions changed, so a second tab re-reads them. */
async function announce(db: Database, agent: Pick<AgentRow, "id" | "ownerOid">): Promise<void> {
  await notify(db, { type: "agent_question", agent_id: agent.id, owner_oid: agent.ownerOid });
}

/**
 * Records a question for the person to answer. Three outcomes, and the caller has to be able to tell them apart,
 * because the hook turns this answer into what the model is told and it must never claim a card that is not there.
 *
 * - **A fresh question** is written. The model is told it is on screen.
 * - **The same question again** — the same `tool_use_id`, whose unique index is what makes this idempotent —
 *   writes nothing and is still success: the client denies the tool whether or not its POST was answered, so a
 *   retry after a lost response finds the card it already put up. The model is told the same thing, truthfully.
 * - **A different question while one is still offered** is refused, because writing it would put two live cards
 *   in one blocked turn and answering either would send a message contradicting the other. Nothing is written, so
 *   the model must be told to ask in words instead — telling it the question is on screen would leave it waiting
 *   for a card that does not exist, which is the stall this whole feature exists to remove.
 *
 * Only a question still *offered* blocks, by `offerExpired` — the same rule the card and the answer read. One past
 * `QUESTION_OFFER_WINDOW_MS` can never be answered, so counting it would leave the session unable to ask anything
 * ever again and the person with no card to clear.
 *
 * A retry does not replace the stored set either — the question is the one the session is waiting on an answer to,
 * and rewriting it under a card the person is reading would change what they are choosing between.
 */
export type QuestionRecorded = "asked" | "already-asked";

export class QuestionNotRecorded extends HttpError {
  constructor() {
    // Literal first, as every refusal here is: the rule in `docs/agent-api.md` is that no caller value leads a
    // message, so nothing a client sends can put a `<` at the front of one.
    super(409, "this session already has a different question waiting for an answer");
  }
}

export async function recordQuestion(prisma: PrismaClient, agent: Pick<AgentRow, "id" | "ownerOid">, post: QuestionPost): Promise<QuestionRecorded> {
  return await prisma.$transaction(async (tx) => {
    // The agent row, so that two questions arriving at once are serialised: the question rows themselves cannot be
    // locked, since the one that matters is usually the one that does not exist yet.
    await tx.$queryRaw`SELECT 1 FROM agent WHERE id = ${agent.id}::uuid FOR UPDATE`;
    // This very question, answered or not. Read before the open-question check below, so a retry of the question
    // already on screen is the success it is rather than the refusal a *different* question would get.
    const same = await tx.agentQuestion.findFirst({ where: { agentId: agent.id, toolUseId: post.tool_use_id }, select: { id: true } });
    if (same !== null) {
      return "already-asked";
    }
    // The newest unanswered one, and the window applied to it here rather than in the `where`, so this reads the
    // one `offerExpired` every other place reads instead of a second spelling of it in SQL. Newest is enough to
    // decide: older ones were asked earlier, so if this one is past the window they all are.
    const open = await tx.agentQuestion.findFirst({
      where: { agentId: agent.id, sessionId: post.session_id, answeredAt: null },
      select: { askedAt: true },
      orderBy: [{ askedAt: "desc" }, { id: "desc" }]
    });
    if (open !== null && !offerExpired(open.askedAt, new Date())) {
      throw new QuestionNotRecorded();
    }
    await tx.agentQuestion.create({
      data: { agentId: agent.id, sessionId: post.session_id, toolUseId: post.tool_use_id, questions: post.questions },
      select: { id: true }
    });
    await announce(tx, agent);
    return "asked";
  });
}

/** A stored question with what every rule about answering it reads: who owns the agent, and whether it is a chat's. */
export interface QuestionRow {
  id: string;
  questions: unknown;
  /** Read by the action, which applies the offer window to it rather than trusting the page that drew the card. */
  askedAt: Date;
  answeredAt: Date | null;
  agent: { id: string; ownerOid: string; virtualAgentId: string | null; assistantConversationId: string | null };
}

export async function findQuestion(db: Database, id: string): Promise<QuestionRow | undefined> {
  const row = await db.agentQuestion.findUnique({
    where: { id },
    select: {
      id: true,
      questions: true,
      askedAt: true,
      answeredAt: true,
      agent: { select: { id: true, ownerOid: true, virtualAgentId: true, assistantConversationId: true } }
    }
  });
  return row ?? undefined;
}

/**
 * Records the answer, inside the transaction of the message carrying it. Refuses a question already answered, which
 * rolls that message back: two tabs on the same card are a real case, and the session must be told once.
 */
export async function recordAnswer(tx: Database, question: QuestionRow, answer: QuestionSetAnswer, messageId: bigint, now: Date = new Date()): Promise<void> {
  const { count } = await tx.agentQuestion.updateMany({
    where: { id: question.id, answeredAt: null },
    // The cast is Prisma's `InputJsonValue`, which wants an index signature a named interface does not have.
    data: { answeredAt: now, answer: { ...answer } as object, answerMessageId: messageId }
  });
  if (count === 0) {
    throw new HttpError(409, "that question has already been answered");
  }
  await announce(tx, question.agent);
}
