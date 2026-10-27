import { HttpError } from "../agent-api/http.ts";
import type { AgentRow } from "../agents/store.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import type { QuestionPost, QuestionSetAnswer } from "./questions.ts";

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
 * Records a question for the person to answer. Idempotent on `tool_use_id`: the client denies the tool whether or not
 * this call was answered, so a retry after a lost response must not put a second card on screen. A retry does not
 * replace the stored set either — the question is the one the session is waiting on an answer to, and rewriting it
 * under a card the person is reading would change what they are choosing between.
 */
export async function recordQuestion(prisma: PrismaClient, agent: Pick<AgentRow, "id" | "ownerOid">, post: QuestionPost): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.agentQuestion.createMany({
      data: [{ agentId: agent.id, sessionId: post.session_id, toolUseId: post.tool_use_id, questions: post.questions }],
      skipDuplicates: true
    });
    if (count > 0) {
      await announce(tx, agent);
    }
  });
}

/** A stored question with what every rule about answering it reads: who owns the agent, and whether it is a chat's. */
export interface QuestionRow {
  id: string;
  questions: unknown;
  answeredAt: Date | null;
  agent: { id: string; ownerOid: string; virtualAgentId: string | null; assistantConversationId: string | null };
}

export async function findQuestion(db: Database, id: string): Promise<QuestionRow | undefined> {
  const row = await db.agentQuestion.findUnique({
    where: { id },
    select: {
      id: true,
      questions: true,
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
