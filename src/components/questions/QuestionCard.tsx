"use client";

import { useId, useState } from "react";
import { MAX_ANSWER_TEXT, type Question, type QuestionAnswer } from "@/questions/questions";
import type { QuestionView } from "@/questions/views";
import type { ActionResult } from "@/web/action";

/**
 * A question the agent's session asked, with its options as buttons and a free-text way out, since
 * `AskUserQuestion` always lets a person answer in their own words. Once answered it shows what was chosen and
 * offers nothing.
 *
 * One component for both places a question appears: the Assistant chat and an agent's page in the hub. They use
 * different palettes, so `tone` picks the class set — everything else about the card, including what a screen reader
 * is told, is the same in each, because a question is the same thing in both.
 */

export type AnswerQuestionAction = (input: { questionId: unknown; answers: unknown }) => Promise<ActionResult>;

export type QuestionTone = "assistant" | "hub";

interface Palette {
  card: string;
  header: string;
  question: string;
  option: string;
  chosen: string;
  description: string;
  field: string;
  submit: string;
  quiet: string;
  muted: string;
  error: string;
}

const PALETTES: Readonly<Record<QuestionTone, Palette>> = {
  assistant: {
    card: "rounded-2xl border border-asst-accent-line bg-asst-raised p-4",
    header: "font-plex-mono text-[11px] uppercase tracking-wider text-asst-accent-soft",
    question: "text-asst-text",
    option: "rounded-xl border border-asst-strong px-3 py-2 text-left text-sm hover:border-asst-accent hover:bg-asst-field",
    chosen: "border-asst-accent bg-asst-field",
    description: "text-[13px] text-asst-muted",
    field: "w-full rounded-xl border border-asst-strong bg-asst-field px-3 py-2 text-sm text-asst-text placeholder:text-asst-faint",
    submit: "rounded-[10px] bg-asst-accent px-4 py-2 text-sm font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-60",
    quiet: "rounded-[10px] border border-asst-strong px-4 py-2 text-sm hover:bg-asst-active disabled:opacity-60",
    muted: "text-[13px] text-asst-muted",
    error: "text-[13px] text-asst-error"
  },
  hub: {
    card: "rounded-lg border border-hub-line bg-hub-raised p-4",
    header: "font-mono text-[11px] uppercase tracking-wide text-hub-muted",
    question: "text-hub-text",
    option: "rounded-md border border-hub-line px-3 py-2 text-left text-sm text-hub-text hover:border-hub-link hover:bg-hub-hover",
    chosen: "border-hub-link bg-hub-hover",
    description: "text-[13px] text-hub-muted",
    field: "w-full rounded-md border border-hub-line bg-hub-pane px-3 py-2 text-sm text-hub-text placeholder:text-hub-muted",
    submit: "rounded-md bg-hub-active px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60",
    quiet: "rounded-md border border-hub-line px-4 py-2 text-sm text-hub-text hover:bg-hub-hover disabled:opacity-60",
    muted: "text-[13px] text-hub-muted",
    error: "text-[13px] text-red-300"
  }
};

/** Nothing chosen for any question yet. */
function emptyAnswers(questions: readonly Question[]): QuestionAnswer[] {
  return questions.map(() => ({ labels: [], text: null }));
}

function replace(answers: readonly QuestionAnswer[], index: number, answer: QuestionAnswer): QuestionAnswer[] {
  return answers.map((current, at) => (at === index ? answer : current));
}

/** Whether every question has something to send: options, words, or both. */
function complete(answers: readonly QuestionAnswer[]): boolean {
  return answers.every((answer) => answer.labels.length > 0 || (answer.text ?? "").trim() !== "");
}

/**
 * What one answered question reads as, which is also what the message said.
 *
 * `undefined` is an answered question whose stored answer this version cannot read, which `agentQuestions` gives
 * an empty `answers`. The card still has to say it is answered: offering a choice again would be a card every
 * press of which is refused, since the question already has an answer.
 */
function said(answer: QuestionAnswer | undefined): string {
  if (answer === undefined) {
    return "Answered, though what was chosen cannot be shown.";
  }
  const picked = answer.labels.join(", ");
  if (picked === "") {
    return answer.text ?? "";
  }
  return answer.text === null ? picked : `${picked} — ${answer.text}`;
}

function Options({
  question,
  index,
  answer,
  palette,
  onChange,
  disabled
}: {
  question: Question;
  index: number;
  answer: QuestionAnswer;
  palette: Palette;
  onChange: (answer: QuestionAnswer) => void;
  disabled: boolean;
}) {
  const group = useId();
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className={palette.question}>{question.question}</legend>
      {question.options.map((option, at) => {
        const chosen = answer.labels.includes(option.label);
        // Built from the positions rather than the label, which is the model's own words and may hold a space.
        const id = `${group}-${index}-${at}`;
        return (
          <label key={at} htmlFor={id} className={`flex cursor-pointer gap-2.5 ${palette.option} ${chosen ? palette.chosen : ""}`}>
            <input
              id={id}
              type={question.multiSelect ? "checkbox" : "radio"}
              name={`${group}-${index}`}
              className="mt-0.5 shrink-0"
              checked={chosen}
              onChange={(event) => {
                const labels = question.multiSelect
                  ? event.target.checked
                    ? [...answer.labels, option.label]
                    : answer.labels.filter((label) => label !== option.label)
                  : [option.label];
                onChange({ ...answer, labels });
              }}
            />
            <span className="min-w-0">
              <span className="block font-medium">{option.label}</span>
              {option.description === "" ? null : <span className={`block ${palette.description}`}>{option.description}</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** Why a card is showing no controls, which decides the one line it says under each question. */
type QuietReason = "answered" | "not-yours" | "expired";

/**
 * The card with nothing to operate: what was asked, and what was chosen once there is an answer.
 *
 * Every control-less state renders through here — the question answered (by someone else, or by this card a moment
 * ago), a reader who may see the agent but not message it, and a question nobody answered inside the window it was
 * offered for. A viewer offered the buttons without the access or the time left to use them is worse than one shown
 * none: the action refuses the press, and its refusal reads as though the card had never been theirs.
 */
function Quiet({
  questions,
  answers,
  reason,
  palette
}: {
  questions: readonly Question[];
  /** `null` for a question with no answer at all, which is what the options below stand in for. */
  answers: readonly QuestionAnswer[] | null;
  reason: QuietReason;
  palette: Palette;
}) {
  return (
    <ol className="flex flex-col gap-3">
      {questions.map((question, index) => (
        <li key={index} className="flex flex-col gap-1">
          <span className={palette.header}>{question.header}</span>
          <span className={palette.question}>{question.question}</span>
          {answers === null ? (
            <>
              <ul className={`list-inside list-disc ${palette.description}`}>
                {question.options.map((option, at) => (
                  <li key={at}>{option.label}</li>
                ))}
              </ul>
              <span className={palette.muted}>
                {reason === "expired" ? "This question was not answered, and the assistant is no longer waiting." : "Waiting for an answer from the owner."}
              </span>
            </>
          ) : (
            // The answer sits in an element of its own rather than as a bare text node beside the screen-reader
            // label, so that what was chosen is addressable: anything matching on an element's whole text — a
            // Playwright locator, or a reader skimming the DOM — would otherwise only ever see "Answer: Red".
            <span className={palette.muted}>
              <span className="sr-only">Answer: </span>
              <span>{said(answers[index])}</span>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * `answer` left out is what makes the card read-only: a viewer who may see the agent but not message it has no
 * action to give it, so the controls cannot be rendered without one. Keeping the two inseparable is the point —
 * a `readOnly` flag beside a live action is a state the caller can get wrong.
 */
export function QuestionCard({ view, tone, answer: send }: { view: QuestionView; tone: QuestionTone; answer?: AnswerQuestionAction }) {
  const palette = PALETTES[tone];
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => emptyAnswers(view.questions));
  const [own, setOwn] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The answer this card sent and had accepted, which is what settles it.
   *
   * It does not wait for the page to come back with the stored answer. An answer is accepted exactly once, so the
   * moment the action says yes there is nothing left to press — and clearing `sending` alone would hand the options
   * back, where a second press is refused as already answered and, in the send-on-press mode, the first, possibly
   * mistaken, choice is already what the session received. Nor can it wait: the redraw rides on the
   * `agent_question` event, and a card that only settles when the stream is up would never settle without it.
   */
  const [accepted, setAccepted] = useState<QuestionAnswer[] | null>(null);
  const plural = view.questions.length !== 1;
  const stored = view.answer?.answers ?? accepted;
  /** The action, only where there is something to do with it. A `const`, so the callbacks below keep the narrowing. */
  const ask = stored === null && view.offered ? send : undefined;

  if (ask === undefined) {
    const reason: QuietReason = stored !== null ? "answered" : view.offered ? "not-yours" : "expired";
    return (
      <section aria-label={plural ? "Questions the assistant asked" : "A question the assistant asked"} className={palette.card}>
        <Quiet questions={view.questions} answers={stored} reason={reason} palette={palette} />
      </section>
    );
  }

  const label = plural ? "Questions for you" : "A question for you";

  /** Keeps whatever was sent once the action accepted it, which is what takes the controls away for good. */
  const settle = (sent: readonly QuestionAnswer[], result: ActionResult): void => {
    setSending(false);
    if (result.ok) {
      setAccepted([...sent]);
    } else {
      setError(result.error);
    }
  };

  // A `const` rather than a declaration, so that `ask` is narrowed inside it: a hoisted function could be called
  // before the guard above ran, which is what TypeScript objects to.
  const submit = async (): Promise<void> => {
    setSending(true);
    setError(null);
    settle(answers, await ask({ questionId: view.id, answers: { answers } }));
  };

  /**
   * A single-choice question with nothing typed sends as soon as an option is pressed, because that is the whole
   * answer. Anything else — several questions, a `multiSelect`, or words of their own — needs a submit.
   */
  const immediate = view.questions.length === 1 && !view.questions[0]?.multiSelect && !own;

  return (
    <section aria-label={label} className={`flex flex-col gap-3.5 ${palette.card}`}>
      {view.questions.map((question, index) => (
        <div key={index} className="flex flex-col gap-2">
          <span className={palette.header}>{question.header}</span>
          <Options
            question={question}
            index={index}
            answer={answers[index] ?? { labels: [], text: null }}
            palette={palette}
            disabled={sending}
            onChange={(next) => {
              const updated = replace(answers, index, next);
              setAnswers(updated);
              if (immediate) {
                setSending(true);
                setError(null);
                void ask({ questionId: view.id, answers: { answers: updated } }).then((result) => settle(updated, result));
              }
            }}
          />
          {own ? (
            <label className="flex flex-col gap-1">
              <span className={palette.muted}>Your own answer to "{question.header}"</span>
              <textarea
                rows={2}
                maxLength={MAX_ANSWER_TEXT}
                disabled={sending}
                className={palette.field}
                value={answers[index]?.text ?? ""}
                onChange={(event) => setAnswers((current) => replace(current, index, { ...(current[index] as QuestionAnswer), text: event.target.value }))}
              />
            </label>
          ) : null}
        </div>
      ))}
      {error === null ? null : (
        <p role="alert" className={palette.error}>
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {own ? null : (
          <button type="button" disabled={sending} className={palette.quiet} onClick={() => setOwn(true)}>
            Something else
          </button>
        )}
        {immediate ? null : (
          <button type="button" disabled={sending || !complete(answers)} className={palette.submit} onClick={() => void submit()}>
            {sending ? "Sending" : "Send answer"}
          </button>
        )}
      </div>
    </section>
  );
}
