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

/** What one answered question reads as, which is also what the message said. */
function said(answer: QuestionAnswer): string {
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

/** Headers and questions, with what was chosen under each: the whole of the card once it has been answered. */
function Answered({ view, palette }: { view: QuestionView; palette: Palette }) {
  return (
    <ol className="flex flex-col gap-3">
      {view.questions.map((question, index) => (
        <li key={index} className="flex flex-col gap-1">
          <span className={palette.header}>{question.header}</span>
          <span className={palette.question}>{question.question}</span>
          <span className={palette.muted}>
            <span className="sr-only">Your answer: </span>
            {said(view.answer?.answers[index] ?? { labels: [], text: null })}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function QuestionCard({ view, tone, answer: send }: { view: QuestionView; tone: QuestionTone; answer: AnswerQuestionAction }) {
  const palette = PALETTES[tone];
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => emptyAnswers(view.questions));
  const [own, setOwn] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = view.questions.length === 1 ? "A question for you" : "Questions for you";

  if (view.answer !== null) {
    return (
      <section aria-label={label} className={palette.card}>
        <Answered view={view} palette={palette} />
      </section>
    );
  }

  async function submit(): Promise<void> {
    setSending(true);
    setError(null);
    const result = await send({ questionId: view.id, answers: { answers } });
    setSending(false);
    if (!result.ok) {
      setError(result.error);
    }
    // Nothing is cleared on success: the card is replaced by the answered one when the page re-reads the question,
    // which the `agent_question` event asks for. Leaving the choice showing until then is what stops it flickering
    // back to empty.
  }

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
                void send({ questionId: view.id, answers: { answers: updated } }).then((result) => {
                  setSending(false);
                  if (!result.ok) {
                    setError(result.error);
                  }
                });
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
