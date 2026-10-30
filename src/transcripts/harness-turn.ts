/**
 * Whether a user turn in a transcript was written by Claude Code's harness rather than typed by the person: the
 * record of a slash command (`<command-name>/clear</command-name>…`), its output and caveat, a system reminder, or a
 * finished background task (`<task-notification>…`). None of them is what a chat is about, so none may name one.
 *
 * The SQL in `prisma/migrations/20261116090000_retitle_harness_titles` and in `store.ts` (`emptyLocalConversationIds`)
 * spells the same list as a regular expression; change them together.
 *
 * Judged by the turn's opening tag, after trimming: a turn that merely mentions one further in is the person's own.
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

export function isHarnessTurn(text: string): boolean {
  const start = text.trimStart();
  return HARNESS_OPENERS.some((opener) => start.startsWith(opener));
}

/** The editor's context an IDE integration puts in front of a prompt: the file that was open, the text selected. */
const IDE_CONTEXT = /^(?:\s*<(ide_opened_file|ide_selection)>[\s\S]*?<\/\1>)+/;

/**
 * What the person typed, without the editor context in front of it: `<ide_opened_file>…</ide_opened_file>` and
 * `<ide_selection>…</ide_selection>` blocks are added by the VS Code and JetBrains integrations to the prompt they
 * send, so the words are what follows them. Text with none is returned as it is.
 */
export function withoutIdeContext(text: string): string {
  return text.replace(IDE_CONTEXT, "").trim();
}
