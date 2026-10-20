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

/** A field's open tag. Named rather than built from a field's name, so no caller's string becomes part of a pattern. */
const TAG = /<([a-z][a-z-]*)>/g;

/** The fields worth showing a person; every other tag the harness writes is internal. */
const SHOWN = ["status", "summary", "event", "result"] as const;

type Shown = (typeof SHOWN)[number];

function shown(name: string): name is Shown {
  return (SHOWN as readonly string[]).includes(name);
}

/**
 * The fields a block carries, read in one pass over its own fields. Each field's content is stepped over once read,
 * so a tag a subagent's report or a monitor's event quotes belongs to that field and never becomes the block's own:
 * a report discussing a notification must not set the row's status. A field is read only once its closing tag is
 * present, so a field the entry was cut part way through is absent rather than half of it reported as the whole, and
 * since the rest of the block is then inside that unclosed field, the scan stops there.
 */
function fields(block: string): Partial<Record<Shown, string>> {
  const found: Partial<Record<Shown, string>> = {};
  // The scan moves `lastIndex` itself, to step over a field's content, so each block starts from the beginning.
  TAG.lastIndex = 0;
  for (let open = TAG.exec(block); open !== null; open = TAG.exec(block)) {
    const name = open[1] ?? "";
    const from = open.index + open[0].length;
    const close = block.indexOf(`</${name}>`, from);
    if (close === -1) {
      return found;
    }
    const value = block.slice(from, close).trim();
    if (shown(name) && found[name] === undefined && value !== "") {
      found[name] = value;
    }
    TAG.lastIndex = close + name.length + "</>".length;
  }
  return found;
}

function read(block: string): TaskNotification | null {
  const { status = null, summary = null, event = null, result = null } = fields(block);
  // None of the three means nothing a person can read, so the text only looks like a notification.
  if (status === null && summary === null && event === null) {
    return null;
  }
  return { status: status?.toLowerCase() ?? null, summary, event, result };
}

/** The tasks read, or `null` when none of the turn's blocks said anything a person can read. */
function nonEmpty(found: TaskNotification[]): TaskNotification[] | null {
  return found.length > 0 ? found : null;
}

/**
 * The tasks a transcript entry's text reports, or `null` when its text is not wholly task notifications and so is
 * something the person wrote. `truncated` is the entry's own flag.
 *
 * A turn may carry more than one block, when several tasks finished together. Anything else in the text means the
 * notification is quoted rather than reported — a prompt that pastes a transcript does this — and falls back to the
 * text itself. A block with no closing tag is the same fallback for a whole entry, but a truncated entry holds only
 * the prefix of its turn that fitted the upload limit, so there its last block is read for the fields that prefix
 * kept: the alternative is showing the raw XML this parser exists to replace. A block that says nothing readable is
 * dropped on its own, so the blocks beside it survive however early the cut landed — the harness writes the ids and
 * the output file before the status, so a prefix can end with all of those and none of these fields.
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
      // Only a truncated entry legitimately ends part way through a block; any other unclosed one is quoted text.
      if (!truncated) {
        return null;
      }
      const cut = read(rest.slice(OPEN.length));
      return nonEmpty(cut === null ? found : [...found, cut]);
    }
    // A block the harness wrote nothing readable into is dropped rather than shown as a blank row, and says nothing
    // about the blocks beside it: only a turn where no block reads at all is text that merely looks like one.
    const task = read(match[1] ?? "");
    if (task !== null) {
      found.push(task);
    }
    rest = rest.slice(match[0].length).trim();
    if (rest !== "" && !rest.startsWith(OPEN)) {
      // A truncated entry can stop part way through the next block's open tag; anything else is quoted text.
      return truncated && OPEN.startsWith(rest) ? nonEmpty(found) : null;
    }
  }
  return nonEmpty(found);
}

/** Statuses that read as a failure. `stopped` is not one: the task was ended deliberately rather than going wrong. */
const FAILED = new Set(["failed", "error", "killed", "timeout"]);

export function taskFailed(status: string | null): boolean {
  return status !== null && FAILED.has(status);
}
