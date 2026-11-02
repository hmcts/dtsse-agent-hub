/**
 * What of a user turn in a transcript the person typed: whether the harness wrote the turn instead, and what is left
 * of it once an IDE's editor context is taken off the front. `typedText` is the one rule; naming a chat
 * (`firstPromptTitle`) and deciding that a transcript batch gives a chat its first content (`appendEntries`) both
 * ask it.
 *
 * The rules are regular expressions kept as source strings, written in a narrow subset that Postgres reads as
 * JavaScript does, because two migrations carry SQL copies of them — `20261116090000_retitle_harness_titles` and the
 * backfill in `20261117090000_conversation_first_content` — and a copy is only safe in a subset both engines agree on:
 *
 * - **No `\s`.** JavaScript's is a fixed Unicode set; Postgres's is the database's locale, which on the hub's server
 *   leaves out U+00A0, U+202F and U+FEFF and adds U+0085. `SPACE` spells JavaScript's set out instead, which is also
 *   exactly what `String.prototype.trim` removes.
 * - **No `.`.** JavaScript's stops at a newline without the `s` flag and Postgres's does not; `[\s\S]` is any
 *   character in both, whatever either thinks a space is.
 * - **No lazy quantifier.** Postgres decides a whole match's length by the first quantifier in it and takes the
 *   longest, so `<a>[\s\S]*?</a>` repeated would run past the first closing tag where JavaScript stops at it. A block
 *   is written as "anything that is not its closing tag", which has one way to match in either engine.
 *
 * `test/integration/migrate.test.ts` holds the first-content backfill to `isTypedPrompt` over the same samples.
 */

/**
 * JavaScript's whitespace, as the inside of a bracket expression: the `WhiteSpace` and `LineTerminator` code points
 * that `\s` and `trim` both use.
 */
const SPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** `text` as a regular expression matching itself, for a literal opener or tag. */
function literal(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * The openers of a turn the harness wrote rather than the person typed: the record of a slash command
 * (`<command-name>/clear</command-name>…`), its output and caveat, a system reminder, a finished background task
 * (`<task-notification>…`), a shell command run with `!` and its output, a prompt hook's output, and the note that the
 * person interrupted a request. None of them is what a chat is about, so none may name one.
 */
const HARNESS_OPENERS = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-",
  "<system-reminder>",
  "<task-notification>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<user-prompt-submit-hook>",
  "[Request interrupted by user"
];

/**
 * A turn the harness wrote: one of `HARNESS_OPENERS` after any leading whitespace. Judged by the opening tag alone, so
 * a turn that merely mentions one further in is the person's own.
 */
export const HARNESS_TURN_PATTERN = `^[${SPACE}]*(?:${HARNESS_OPENERS.map(literal).join("|")})`;

const HARNESS_TURN = new RegExp(HARNESS_TURN_PATTERN);

export function isHarnessTurn(text: string): boolean {
  return HARNESS_TURN.test(text);
}

/** The blocks an IDE integration puts in front of a prompt: the file that was open, and the text selected in it. */
const IDE_TAGS = ["ide_opened_file", "ide_selection"];

/**
 * The editor context at the start of a prompt: one or more `IDE_TAGS` blocks, each from its opening tag to the first
 * closing tag of the same name, with whitespace between them.
 */
export const IDE_CONTEXT_PATTERN = `^(?:[${SPACE}]*(?:${IDE_TAGS.map((tag) => `<${tag}>(?:(?!</${tag}>)[\\s\\S])*</${tag}>`).join("|")}))+`;

const IDE_CONTEXT = new RegExp(IDE_CONTEXT_PATTERN);

/** Somewhere in the text, a character that is not whitespace: what is left has words in it. */
export const WORDS_PATTERN = `[^${SPACE}]`;

/**
 * What the person typed, without the editor context in front of it: `<ide_opened_file>…</ide_opened_file>` and
 * `<ide_selection>…</ide_selection>` blocks are added by the VS Code and JetBrains integrations to the prompt they
 * send, so the words are what follows them. Text with none is returned as it is, trimmed.
 */
export function withoutIdeContext(text: string): string {
  return text.replace(IDE_CONTEXT, "").trim();
}

/**
 * The words of a user turn that the person typed: what is left once the editor context is taken off, or null when
 * nothing is left or the turn is one the harness wrote. A prompt of nothing but `<ide_opened_file>` has none, nor has
 * `/clear`'s record.
 */
export function typedText(text: string): string | null {
  const typed = withoutIdeContext(text);
  return typed === "" || isHarnessTurn(typed) ? null : typed;
}

/** Whether a user turn is something the person said: `typedText` has words for it. */
export function isTypedPrompt(text: string): boolean {
  return typedText(text) !== null;
}
