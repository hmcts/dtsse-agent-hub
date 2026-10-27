import type { Database } from "../store/prisma.ts";
import { type Question, type QuestionSetAnswer, storedAnswer, storedQuestions } from "./questions.ts";

/** A session's intercepted questions as a page shows them: the card's content, and what was chosen if anything. */

export interface QuestionView {
  id: string;
  agentId: string;
  askedAt: string;
  questions: Question[];
  /** `null` while the card is still offering a choice. */
  answer: (QuestionSetAnswer & { at: string }) | null;
}

const SELECT = { id: true, agentId: true, askedAt: true, questions: true, answeredAt: true, answer: true } as const;

interface Row {
  id: string;
  agentId: string;
  askedAt: Date;
  questions: unknown;
  answeredAt: Date | null;
  answer: unknown;
}

function toView(row: Row): QuestionView {
  const answer = row.answeredAt === null ? null : storedAnswer(row.answer);
  return {
    id: row.id,
    agentId: row.agentId,
    askedAt: row.askedAt.toISOString(),
    questions: storedQuestions(row.questions),
    answer: answer === null || row.answeredAt === null ? null : { ...answer, at: row.answeredAt.toISOString() }
  };
}

/**
 * The questions one agent's sessions asked, oldest first.
 *
 * No access check of its own: the callers read it for an agent they have already decided the viewer may see, the
 * same way `agentConversation` is read, and a question says no more than the transcript entry it replaced did.
 *
 * A question whose stored set this version cannot read is left out rather than shown as an empty card: there is
 * nothing for the person to choose between, and the session has been told to ask in words if it matters.
 */
export async function agentQuestions(db: Database, agentId: string): Promise<QuestionView[]> {
  const rows = await db.agentQuestion.findMany({ where: { agentId }, select: SELECT, orderBy: [{ askedAt: "asc" }, { id: "asc" }] });
  return rows.map(toView).filter((view) => view.questions.length > 0);
}
