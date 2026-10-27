import { z } from "zod";
import { boundedArray } from "../agent-api/bounded-array.ts";

/**
 * A question a session's model asked with Claude Code's `AskUserQuestion` tool, which the client's `PreToolUse` hook
 * intercepts wherever nobody is at the keyboard: the limits, the POST body, what a person's answer may be, and the
 * message their answer is sent as. Pure, so the server's first render, the live update and the write all agree.
 *
 * The shape mirrors `AskUserQuestion`'s own, because that is what the client has to send: 1-4 questions, each with a
 * short header, 2-4 options of a label and a description, and whether more than one may be chosen. The client applies
 * the same caps before it sends, so the hub refusing a body is a client bug rather than a question nobody can read.
 *
 * `AskUserQuestion` always lets a person answer in their own words, so every question here can be answered with text
 * instead of a label. See "Questions" in docs/agent-api.md.
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_QUESTION = 1000;
export const MAX_HEADER = 40;
export const MAX_OPTION_LABEL = 200;
export const MAX_OPTION_DESCRIPTION = 500;
/** A person's own words, in place of an option. Bounded well under `MAX_BODY`, since several answers share a message. */
export const MAX_ANSWER_TEXT = 2000;
export const MAX_TOOL_USE_ID = 200;
export const MAX_SESSION_ID = 200;

const label = z.string().trim().min(1).max(MAX_OPTION_LABEL);

export const questionOption = z.object({ label, description: z.string().trim().max(MAX_OPTION_DESCRIPTION) }).strict();

export const question = z
  .object({
    question: z.string().trim().min(1).max(MAX_QUESTION),
    header: z.string().trim().min(1).max(MAX_HEADER),
    options: boundedArray(questionOption, MAX_OPTIONS, { min: MIN_OPTIONS }),
    multiSelect: z.boolean()
  })
  .strict();

/** `POST /api/agent/{agent_id}/question`. */
export const questionPostBody = z
  .object({
    session_id: z.string().trim().min(1).max(MAX_SESSION_ID),
    tool_use_id: z.string().trim().min(1).max(MAX_TOOL_USE_ID),
    questions: boundedArray(question, MAX_QUESTIONS, { min: 1 })
  })
  .strict();

export type QuestionOption = z.infer<typeof questionOption>;
export type Question = z.infer<typeof question>;
export type QuestionPost = z.infer<typeof questionPostBody>;

/**
 * One question's answer: the options the person chose, or words of their own. Both is allowed — "Red, and here is
 * why" is a real answer — and neither is not, which `checkAnswer` is what enforces.
 */
export interface QuestionAnswer {
  labels: string[];
  text: string | null;
}

/** Every answer of one question set, in the order the questions were asked. */
export interface QuestionSetAnswer {
  answers: QuestionAnswer[];
}

/** The questions as a stored row carries them, or `[]` for a row this version cannot read. */
export function storedQuestions(value: unknown): Question[] {
  const parsed = boundedArray(question, MAX_QUESTIONS).safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** The answer as a stored row carries it, or `null` for a row this version cannot read. */
export function storedAnswer(value: unknown): QuestionSetAnswer | null {
  if (typeof value !== "object" || value === null || !("answers" in value) || !Array.isArray(value.answers)) {
    return null;
  }
  const answers: QuestionAnswer[] = [];
  for (const entry of value.answers) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const raw = entry as Record<string, unknown>;
    const labels = Array.isArray(raw.labels) ? raw.labels.filter((value): value is string => typeof value === "string") : [];
    answers.push({ labels, text: typeof raw.text === "string" && raw.text !== "" ? raw.text : null });
  }
  return { answers };
}

/** The refusal to show the person, or the answer to record. */
export type CheckedAnswer = { ok: true; answer: QuestionSetAnswer } | { ok: false; error: string };

/**
 * A person's picks checked against the question set they are answering: one entry per question, in order, each
 * either naming options the question offered or carrying words of their own.
 *
 * A label the question does not offer is refused rather than passed through: the labels are what the message says,
 * and a session told its own option was chosen when it was not is worse than a refusal the person can see.
 */
export function checkAnswer(questions: readonly Question[], raw: unknown): CheckedAnswer {
  const given = storedAnswer(raw);
  if (given === null || given.answers.length !== questions.length) {
    return { ok: false, error: "answer every question before sending" };
  }
  const answers: QuestionAnswer[] = [];
  for (const [index, asked] of questions.entries()) {
    const answer = given.answers[index] as QuestionAnswer;
    const text = answer.text === null ? null : answer.text.trim().slice(0, MAX_ANSWER_TEXT);
    const offered = asked.options.map((option) => option.label);
    const labels = [...new Set(answer.labels)].filter((chosen) => offered.includes(chosen));
    if (labels.length !== answer.labels.length) {
      return { ok: false, error: "that is not one of the options offered" };
    }
    if (labels.length > 1 && !asked.multiSelect) {
      return { ok: false, error: "only one option can be chosen for that question" };
    }
    if (labels.length === 0 && (text === null || text === "")) {
      return { ok: false, error: "choose an option, or write your own answer" };
    }
    answers.push({ labels, text: text === "" ? null : text });
  }
  return { ok: true, answer: { answers } };
}

/** The labels joined as one phrase, for a `multiSelect` question the person chose several options for. */
function chosen(labels: readonly string[]): string {
  return labels.length < 2 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** What one question's answer reads as: the options chosen, their own words, or the options and then the words. */
function said(answer: QuestionAnswer): string {
  const picked = chosen(answer.labels);
  if (picked === "") {
    return answer.text ?? "";
  }
  return answer.text === null ? picked : `${picked} — ${answer.text}`;
}

/**
 * The message the session receives for a question set the person answered. An ordinary direct message, so it reaches
 * the session through the delivery and wake machinery every other message uses, and the turn the question came from
 * is already over.
 *
 * Each question is quoted back above its answer: the session asked it several turns ago at worst, and an answer of
 * "Red" on its own is one it has to go looking for the question for.
 */
export function answerMessage(questions: readonly Question[], answer: QuestionSetAnswer): string {
  const lead = questions.length === 1 ? "Answering your question." : "Answering your questions.";
  const blocks = questions.map((asked, index) => `${asked.question}\n${said(answer.answers[index] ?? { labels: [], text: null })}`);
  return [lead, ...blocks].join("\n\n");
}
