/**
 * A finished background task, as Claude Code's harness reports it back into a session.
 *
 * The harness injects the report as a user turn whose text is a `<task-notification>` block, so without this the
 * transcript shows raw XML attributed to the person who owns the session, which they never typed. Parsed here at
 * render time rather than in the client that uploads transcripts, so entries already stored render the same way.
 */

export interface TaskNotification {
  /** How the task ended, lower case, as the harness worded it; `null` when it did not say, which a monitor's does not. */
  status: string | null;
  /** One line saying what finished, or which monitor fired; `null` when it did not say. */
  summary: string | null;
  /** What a monitor watching a running task just reported, in the monitored command's own words; `null` for a task that ended. */
  event: string | null;
  /** A subagent's closing report, which is nowhere else in this transcript: its own turns are a sidechain. */
  result: string | null;
}

const OPEN = "<task-notification>";

const BLOCK = /^<task-notification>([\s\S]*?)<\/task-notification>/;

/** Named rather than built from the tag, so no caller's string can become part of a pattern. */
const FIELDS = {
  status: /<status>([\s\S]*?)<\/status>/,
  summary: /<summary>([\s\S]*?)<\/summary>/,
  event: /<event>([\s\S]*?)<\/event>/,
  result: /<result>([\s\S]*?)<\/result>/
} as const;

/**
 * One field of a block, or `null` when the block does not carry it. A field is read only once the block closes it, so
 * a field the entry was cut part way through is absent rather than half of it reported as the whole.
 */
function field(block: string, name: keyof typeof FIELDS): string | null {
  const found = FIELDS[name].exec(block)?.[1]?.trim();
  return found === undefined || found === "" ? null : found;
}

function read(block: string): TaskNotification | null {
  const status = field(block, "status");
  const summary = field(block, "summary");
  const event = field(block, "event");
  // None of the three means nothing a person can read, so the text only looks like a notification.
  if (status === null && summary === null && event === null) {
    return null;
  }
  return { status: status?.toLowerCase() ?? null, summary, event, result: field(block, "result") };
}

/**
 * The tasks a transcript entry's text reports, or `null` when its text is not wholly task notifications and so is
 * something the person wrote. `truncated` is the entry's own flag.
 *
 * A turn may carry more than one block, when several tasks finished together. Anything else in the text means the
 * notification is quoted rather than reported — a prompt that pastes a transcript does this — and falls back to the
 * text itself. A block with no closing tag is the same fallback for a whole entry, but a truncated entry holds only
 * the prefix of its turn that fitted the upload limit, so there its last block is read for the fields that prefix
 * kept: the alternative is showing the raw XML this parser exists to replace.
 */
export function taskNotifications(text: string, { truncated = false }: { truncated?: boolean } = {}): TaskNotification[] | null {
  let rest = text.trim();
  if (!rest.startsWith(OPEN)) {
    return null;
  }
  const found: TaskNotification[] = [];
  while (rest !== "") {
    const match = BLOCK.exec(rest);
    if (match === null) {
      const cut = truncated ? read(rest.slice(OPEN.length)) : null;
      return cut === null ? null : [...found, cut];
    }
    const task = read(match[1] ?? "");
    if (task === null) {
      return null;
    }
    found.push(task);
    rest = rest.slice(match[0].length).trim();
    if (rest !== "" && !rest.startsWith(OPEN)) {
      // A truncated entry can stop part way through the next block's open tag; anything else is quoted text.
      return truncated && OPEN.startsWith(rest) ? found : null;
    }
  }
  return found;
}

/** Statuses that read as a failure. `stopped` is not one: the task was ended deliberately rather than going wrong. */
const FAILED = new Set(["failed", "error", "killed", "timeout"]);

export function taskFailed(status: string | null): boolean {
  return status !== null && FAILED.has(status);
}
