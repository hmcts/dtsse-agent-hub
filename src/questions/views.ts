import { type AgentRef, canViewTranscript } from "../access/rules.ts";
import type { Database } from "../store/prisma.ts";
import { MAX_SHOWN_QUESTIONS, offerExpired, type Question, type QuestionAnswer, storedAnswer, storedQuestions } from "./questions.ts";

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
  /**
   * Whether an answer is still wanted. `false` for a question answered, and for one left unanswered past
   * `QUESTION_OFFER_WINDOW_MS` — the card then shows what was asked and offers nothing, and the thread stops
   * saying the assistant is waiting on the person. The action applies the same rule to the clock at the time of the
   * press, which is what actually enforces it: a page left open overnight cannot be trusted about the date.
   */
  offered: boolean;
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

function toView(row: Row, now: Date): QuestionView {
  return {
    id: row.id,
    agentId: row.agentId,
    askedAt: row.askedAt.toISOString(),
    questions: storedQuestions(row.questions),
    answer: row.answeredAt === null ? null : { answers: storedAnswer(row.answer)?.answers ?? [], at: row.answeredAt.toISOString() },
    offered: row.answeredAt === null && !offerExpired(row.askedAt, now)
  };
}

/**
 * The questions one agent's sessions asked, oldest first, for a viewer who may read that agent's transcript.
 *
 * `canViewTranscript` rather than `canViewAgent`: a question is the model's own words, as a transcript entry is, and
 * that rule exists so who may read those can be narrowed without changing who may see the agent — which is the seam
 * to reach for if a question ever has to be shown to someone a session itself is not. Answering one is a separate
 * decision, made in `src/app/_actions/questions.ts` with `canPersonMessageAgent`.
 *
 * At most `MAX_SHOWN_QUESTIONS`, the newest kept: the transcript beside this is paginated and these are not, so a
 * long-lived conversation would otherwise carry every card it had ever been asked on every load. The read is
 * newest-first for that reason and reversed here, because the thread merges them in time order.
 *
 * A question whose stored set this version cannot read is left out rather than shown as an empty card: there is
 * nothing for the person to choose between, and the session has been told to ask in words if it matters.
 */
export async function agentQuestions(db: Database, viewerOid: string, agent: AgentRef, now: Date = new Date()): Promise<QuestionView[]> {
  if (!canViewTranscript(viewerOid, agent)) {
    return [];
  }
  const rows = await db.agentQuestion.findMany({
    where: { agentId: agent.id },
    select: SELECT,
    orderBy: [{ askedAt: "desc" }, { id: "desc" }],
    take: MAX_SHOWN_QUESTIONS
  });
  return rows
    .reverse()
    .map((row) => toView(row, now))
    .filter((view) => view.questions.length > 0);
}
