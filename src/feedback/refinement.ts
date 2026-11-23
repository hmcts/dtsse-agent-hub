import { DEFAULT_PRODUCT } from "../assistant/products.ts";
import { MAX_BODY } from "../messages/limits.ts";
import { ukLongDate } from "../web/format.ts";
import { describeElement } from "./anchor-words.ts";
import { pageName } from "./team-views.ts";
import type { FeedbackThreadView } from "./thread-store.ts";

/**
 * Refining a project's feedback with the Assistant: the team picks threads, perhaps gives them themes, and starts a
 * conversation whose first message hands the assistant those threads and asks it to refine each theme's requirement
 * into one Jira story with options, each in its own ticket document so the person can edit it and send it to Jira on
 * its own. The team's themes are kept as they are; the assistant only suggests themes for threads that have none. Pure, so
 * the message a click sends is unit-tested; `refineFeedback` sends it through the Assistant.
 */

/** Most threads one refinement takes: past this, a story is several stories and the person should pick again. */
export const MAX_REFINE_THREADS = 40;

/** Longest theme a thread is given, which is a label rather than a sentence. */
export const MAX_THEME = 60;

/** Most of one comment quoted to the assistant, so one long comment cannot crowd the others out of the message. */
export const MAX_QUOTED_COMMENT = 1500;

const NO_THEME = "No theme";

/** A theme as the browser sent it: trimmed, with its whitespace run together; `null` clears it; `undefined` refuses it. */
export function checkTheme(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const theme = value.replace(/\s+/g, " ").trim();
  if (theme === "") {
    return null;
  }
  return theme.length > MAX_THEME ? undefined : theme;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The threads in the order the message lists them: by theme, those with none last, then by page and when raised. */
export function refinementOrder<T extends Pick<FeedbackThreadView, "theme" | "pagePath" | "createdAt" | "id">>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (a, b) =>
      Number(a.theme === null) - Number(b.theme === null) ||
      byCodePoint(a.theme ?? "", b.theme ?? "") ||
      byCodePoint(a.pagePath, b.pagePath) ||
      byCodePoint(a.createdAt, b.createdAt) ||
      byCodePoint(a.id, b.id)
  );
}

function quote(body: string): string {
  const cut = body.length > MAX_QUOTED_COMMENT ? `${body.slice(0, MAX_QUOTED_COMMENT)}…` : body;
  return cut.replace(/\s*\n\s*/g, " / ").trim();
}

function threadBlock(thread: FeedbackThreadView, number: number, linkLabel: string | null): string {
  const [first, ...replies] = thread.comments;
  const where = `${pageName(thread)}${thread.pageTitle === null ? "" : ` (${thread.pagePath})`}${linkLabel === null ? "" : `, ${linkLabel}`}`;
  const lines = [
    `[${number}] On ${where}, ${describeElement(thread.anchor)}${thread.status === "resolved" ? " (resolved)" : ""} — ${first === undefined ? "no comment" : `${first.author.name}: "${quote(first.body)}"`}`
  ];
  for (const reply of replies) {
    lines.push(`    Reply from ${reply.author.name}: "${quote(reply.body)}"`);
  }
  return lines.join("\n");
}

function opening(projectName: string, count: number): string {
  return [
    `I'm refining feedback from testing the prototype "${projectName}" into Jira stories. Below ${count === 1 ? "is 1 comment" : `are ${count} comments`} reviewers left on its pages, under the themes the team has given them. Each theme is one Jira story.`,
    "",
    'Keep the team\'s themes exactly as they are: do not rename, merge or split them, or move comments between them. If some comments are under "No theme", group those into suggested themes of their own, and tell me which comments you put in each so I can confirm them.',
    "",
    "Then, for each theme:",
    "1. Say what the requirement is: the problem its comments point to, in plain language, citing the comments by number.",
    "2. Suggest 2 or 3 options for meeting it. For each, say what changes for the user, its pros and cons, and roughly how much work it is.",
    "3. Recommend one option, and say why.",
    '4. Draft one Jira story for it: a title, a user story ("As a … I want … so that …"), the background and the evidence from the comments, the options considered, and acceptance criteria written as Given, When, Then.',
    "",
    'Put each story in its own ticket document in the document panel, titled with its theme (`scripts/agent-hub artefact new --kind ticket --title "<theme>"`, then write it with `scripts/agent-hub artefact put --id <id>`), so I can review each one and send it to Jira on its own. Ask me if anything is unclear before you write them.'
  ].join("\n");
}

/**
 * What `startConversation` is sent to refine `threads` of `projectName`: the default product, since a project is not
 * one of the Assistant's products; a title naming the project and the day; and a body that stays under the message
 * limit, leaving out whole threads from the end, and saying how many, rather than cutting one short.
 */
export function refinementRequest(input: {
  projectName: string;
  threads: readonly FeedbackThreadView[];
  /** A link's label, for a project with more than one link; null leaves links unnamed. */
  linkLabel: ((linkId: string) => string) | null;
  now: Date;
}): { product: string; title: string; body: string } {
  const ordered = refinementOrder(input.threads).slice(0, MAX_REFINE_THREADS);
  // The opening says how many comments follow, which is only known once they are fitted in: room is kept for the
  // longest it could be.
  const room = Math.max(opening(input.projectName, ordered.length).length, opening(input.projectName, 1).length);
  const sections: string[] = [];
  let used = room;
  let theme: string | undefined;
  let included = 0;
  for (const [index, thread] of ordered.entries()) {
    const heading = (thread.theme ?? NO_THEME) === theme ? "" : `\n\nTheme: ${thread.theme ?? NO_THEME}`;
    const block = `${heading}\n${threadBlock(thread, index + 1, input.linkLabel === null ? null : input.linkLabel(thread.linkId))}`;
    // Room for the note on what was left out, whatever its count.
    if (used + block.length + 120 > MAX_BODY) {
      break;
    }
    sections.push(block);
    used += block.length;
    theme = thread.theme ?? NO_THEME;
    included += 1;
  }
  const left = ordered.length - included;
  const note =
    left === 0 ? "" : `\n\n(${left === 1 ? "1 more comment was" : `${left} more comments were`} left out to keep this message short enough to send.)`;
  return {
    product: DEFAULT_PRODUCT,
    title: `Refine feedback: ${input.projectName}, ${ukLongDate(input.now)}`,
    body: `${opening(input.projectName, included)}${sections.join("")}${note}`
  };
}
