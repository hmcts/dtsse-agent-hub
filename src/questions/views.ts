import { type AgentRef, canViewTranscript, type Grant } from "../access/rules.ts";
import type { Database } from "../store/prisma.ts";
import { type Question, type QuestionAnswer, storedAnswer, storedQuestions } from "./questions.ts";

/** A session's intercepted questions as a page shows them: the card's content, and what was chosen if anything. */

export interface QuestionView {
  id: string;
  agentId: string;
  askedAt: string;
  questions: Question[];
  /**
   * `null` while the card is still offering a choice.
   *
   * `answers` is empty for a row that was answered but whose answer this version cannot read — the question is
   * answered either way, and the card says so without saying what was chosen. It must not read as unanswered: it
   * would offer a choice again, and `recordAnswer` refuses a question that already has one, so every press would
   * fail.
   */
  answer: { answers: QuestionAnswer[]; at: string } | null;
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
  return {
    id: row.id,
    agentId: row.agentId,
    askedAt: row.askedAt.toISOString(),
    questions: storedQuestions(row.questions),
    answer: row.answeredAt === null ? null : { answers: storedAnswer(row.answer)?.answers ?? [], at: row.answeredAt.toISOString() }
  };
}

/**
 * The questions one agent's sessions asked, oldest first, for a viewer who may read that agent's transcript.
 *
 * `canViewTranscript` rather than `canViewAgent`: a question is the model's own words, as a transcript entry is,
 * and that rule exists so who may read those can be narrowed without changing who may see the agent — which
 * `agentConversation` already does for the transcript beside this. Answering one is a separate decision, made in
 * `src/app/_actions/questions.ts` with `canPersonMessageAgent`.
 *
 * A question whose stored set this version cannot read is left out rather than shown as an empty card: there is
 * nothing for the person to choose between, and the session has been told to ask in words if it matters.
 */
export async function agentQuestions(db: Database, viewerOid: string, agent: AgentRef, grants: readonly Grant[]): Promise<QuestionView[]> {
  if (!canViewTranscript(viewerOid, agent, grants)) {
    return [];
  }
  const rows = await db.agentQuestion.findMany({ where: { agentId: agent.id }, select: SELECT, orderBy: [{ askedAt: "asc" }, { id: "asc" }] });
  return rows.map(toView).filter((view) => view.questions.length > 0);
}
