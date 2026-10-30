/**
 * Whether a user turn in a transcript was written by Claude Code's harness rather than typed by the person: the
 * record of a slash command (`<command-name>/clear</command-name>…`), its output and caveat, a system reminder, or a
 * finished background task (`<task-notification>…`). None of them is what a chat is about, so none may name one.
 *
 * Judged by the turn's opening tag, after trimming: a turn that merely mentions one further in is the person's own.
 */
const HARNESS_OPENERS = ["<command-name>", "<command-message>", "<command-args>", "<local-command-", "<system-reminder>", "<task-notification>"];

export function isHarnessTurn(text: string): boolean {
  const start = text.trimStart();
  return HARNESS_OPENERS.some((opener) => start.startsWith(opener));
}
