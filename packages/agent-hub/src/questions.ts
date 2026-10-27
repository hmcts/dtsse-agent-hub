// Claude Code's own `AskUserQuestion` tool, intercepted for a session nobody is sitting at: the question is sent to
// agent-hub, where the person reads it as a card with its options, and the tool is denied so the TUI prompt is never
// drawn. Pure — reading a `PreToolUse` payload, bounding it to what the hub accepts, and the two deny reasons.
//
// The caps mirror the hub's (`src/questions/questions.ts`) and `AskUserQuestion`'s own shape. They are applied here
// rather than left to the hub because a refused POST and a failed POST are the same thing to the hook: a question the
// person never sees. Values are cut to fit instead of being rejected, since a question cut short still asks
// something, where no question at all leaves the session waiting on a prompt that will never be answered.

export const ASK_USER_QUESTION = "AskUserQuestion";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_QUESTION = 1000;
export const MAX_HEADER = 40;
export const MAX_OPTION_LABEL = 200;
export const MAX_OPTION_DESCRIPTION = 500;

/** One option the model offers. `description` may be empty: the tool allows it and the card shows the label alone. */
export type QuestionOption = {
  label: string;
  description: string;
};

export type Question = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
};

/** `POST /api/agent/{agent_id}/question`, as `docs/agent-api.md` gives it. */
export type QuestionBody = {
  session_id: string;
  tool_use_id: string;
  questions: Question[];
};

/** The documented `PreToolUse` hook output: a decision the CLI prints as is. */
export type HookDenyOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
};

/**
 * What the model is told when the question reached the hub. It has to stop rather than carry on, and it must not
 * repeat the question as prose: the person already has it on screen with its options, and a second copy in the
 * answer reads as the assistant asking twice and invites a reply in the wrong place.
 */
export const ASKED_REASON =
  "Your question is on screen for the person now, with its options. Their answer will arrive as an ordinary message. End your turn here and wait for it: do not call this tool again, do not repeat the question in your reply, and do not guess an answer.";

/**
 * What it is told when the question did not reach the hub. Asking in words is the fallback that always works, because
 * whatever the person reads the reply in, they can answer it with a message. There is no path that lets the tool run:
 * the prompt would wait for a keyboard nobody is at and the turn would never end.
 */
export const UNDELIVERED_REASON =
  "This question could not be put on screen, and there is nobody at a terminal to answer the prompt. Ask it in plain words in your reply instead, listing the choices, and end your turn so the person can answer with a message.";

export function denyOutput(reason: string): HookDenyOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A required string, trimmed and cut to `max`; `null` when there is nothing left of it. */
function cut(value: unknown, max: number): string | null {
  const text = (typeof value === "string" ? value : "").trim().slice(0, max).trim();
  return text === "" ? null : text;
}

function parseOption(value: unknown): QuestionOption | null {
  const raw = record(value);
  const label = cut(raw?.label, MAX_OPTION_LABEL);
  if (label === null) {
    return null;
  }
  return { label, description: cut(raw?.description, MAX_OPTION_DESCRIPTION) ?? "" };
}

function parseQuestion(value: unknown): Question | null {
  const raw = record(value);
  const question = cut(raw?.question, MAX_QUESTION);
  const header = cut(raw?.header, MAX_HEADER);
  if (question === null || header === null || !Array.isArray(raw?.options)) {
    return null;
  }
  const options: QuestionOption[] = [];
  for (const entry of raw.options.slice(0, MAX_OPTIONS)) {
    const option = parseOption(entry);
    // One unreadable option would change what the person is choosing between, so the question goes rather than
    // being offered with a gap in it.
    if (option === null) {
      return null;
    }
    options.push(option);
  }
  // Two options sharing a label are an ambiguous choice: the label is what the person's answer says and what the
  // card keys their press by, so neither the hub nor the session could tell which one they meant. The hub refuses
  // such a question, so sending it would be a card nobody ever sees; asking in words is the better outcome.
  if (options.length < MIN_OPTIONS || new Set(options.map((option) => option.label)).size !== options.length) {
    return null;
  }
  return { question, header, options, multiSelect: raw.multiSelect === true };
}

/**
 * The questions a `PreToolUse` payload's `tool_input` carries, or `null` when nothing usable can be made of it.
 *
 * `null` is not "allow the tool": the caller denies either way, with the reason that tells the model to ask in words.
 * Questions past `MAX_QUESTIONS` are dropped, because the tool itself refuses more and the hub bounds them too.
 */
export function parseQuestions(toolInput: unknown): Question[] | null {
  const raw = record(toolInput);
  if (!Array.isArray(raw?.questions)) {
    return null;
  }
  const questions: Question[] = [];
  for (const entry of raw.questions.slice(0, MAX_QUESTIONS)) {
    const question = parseQuestion(entry);
    if (question === null) {
      return null;
    }
    questions.push(question);
  }
  return questions.length === 0 ? null : questions;
}
