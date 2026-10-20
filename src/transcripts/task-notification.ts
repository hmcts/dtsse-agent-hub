/**
 * A finished background task, as Claude Code's harness reports it back into a session.
 *
 * The harness injects the report as a user turn whose text is a `<task-notification>` block, so without this the
 * transcript shows raw XML attributed to the person who owns the session, which they never typed. Parsed here at
 * render time rather than in the client that uploads transcripts, so entries already stored render the same way.
 */

export interface TaskNotification {
  /** How the task ended, lower case, as the harness worded it; `null` when it did not say. */
  status: string | null;
  /** One line saying what finished; `null` when it did not say. */
  summary: string | null;
  /** A subagent's closing report, which is nowhere else in this transcript: its own turns are a sidechain. */
  result: string | null;
}

const OPEN = "<task-notification>";

const BLOCK = /^<task-notification>([\s\S]*?)<\/task-notification>/;

/** Named rather than built from the tag, so no caller's string can become part of a pattern. */
const FIELDS = {
  status: /<status>([\s\S]*?)<\/status>/,
  summary: /<summary>([\s\S]*?)<\/summary>/,
  result: /<result>([\s\S]*?)<\/result>/
} as const;

function field(block: string, name: keyof typeof FIELDS): string | null {
  const found = FIELDS[name].exec(block)?.[1]?.trim();
  return found === undefined || found === "" ? null : found;
}

/**
 * The tasks a transcript entry's text reports, or `null` when its text is not wholly task notifications and so is
 * something the person wrote.
 *
 * A turn may carry more than one block, when several tasks finished together. Anything else in the text means the
 * notification is quoted rather than reported — a prompt that pastes a transcript does this — and a block with no
 * closing tag means the entry was truncated, so both fall back to the text itself rather than render half a report.
 */
export function taskNotifications(text: string): TaskNotification[] | null {
  let rest = text.trim();
  if (!rest.startsWith(OPEN)) {
    return null;
  }
  const found: TaskNotification[] = [];
  while (rest !== "") {
    const match = BLOCK.exec(rest);
    if (match === null) {
      return null;
    }
    const block = match[1] ?? "";
    const status = field(block, "status");
    const summary = field(block, "summary");
    // Neither field means nothing a person can read, so the text only looks like a notification.
    if (status === null && summary === null) {
      return null;
    }
    found.push({ status: status?.toLowerCase() ?? null, summary, result: field(block, "result") });
    rest = rest.slice(match[0].length).trim();
    if (rest !== "" && !rest.startsWith(OPEN)) {
      return null;
    }
  }
  return found;
}

/** Statuses that read as a failure. `stopped` is not one: the task was ended deliberately rather than going wrong. */
const FAILED = new Set(["failed", "error", "killed", "timeout"]);

export function taskFailed(status: string | null): boolean {
  return status !== null && FAILED.has(status);
}
