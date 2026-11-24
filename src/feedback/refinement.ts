import { DEFAULT_PRODUCT } from "../assistant/products.ts";
import { MAX_BODY } from "../messages/limits.ts";
import { ukLongDate } from "../web/format.ts";
import { describeElement } from "./anchor-words.ts";
import { pageName } from "./team-views.ts";
import type { FeedbackThreadView } from "./thread-store.ts";

/**
 * Refining a project's feedback with the Assistant: the team picks threads, perhaps under themes they gave them, and
 * starts a conversation whose first message hands the assistant those threads and asks, as the person chose, for one
 * Jira story from them all (`one`), or for the comments to be worked through one at a time into as many stories as
 * they need (`each`). Every story is written into a document of the conversation, which the person edits and sends to
 * Jira from the document panel. Pure, so the message a click sends is unit-tested; `refineFeedback` sends it.
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

/** One Jira story from every comment chosen, or as many as working through them one at a time needs. */
export type RefineMode = "one" | "each";

export function isRefineMode(value: unknown): value is RefineMode {
  return value === "one" || value === "each";
}

const STORY =
  'a title, a user story ("As a … I want … so that …"), the background and the evidence from the comments, 2 or 3 options for meeting the need with what changes for the user, their pros and cons and roughly how much work each is, the option you recommend and why, and acceptance criteria written as Given, When, Then';

function opening(projectName: string, count: number, mode: RefineMode): string {
  const comments = count === 1 ? "is 1 comment" : `are ${count} comments`;
  const ask =
    mode === "one"
      ? [
          "Please turn these comments into one Jira story. Work out the single need they point to, citing the comments by number, then draft the story: " +
            STORY +
            ".",
          "",
          "Write the story into this conversation's document, so I can edit it and send it to Jira from the document panel."
        ]
      : [
          "Please go through the comments one at a time, in order. For each, say in plain language what the user needs. Where several comments need the same change, say so and treat them as one need.",
          "",
          `Then draft one Jira story for each need: ${STORY}.`,
          "",
          'Put each story in its own ticket document (`scripts/agent-hub artefact new --kind ticket --title "<story title>"`), so I can edit each one and send it to Jira on its own. List the stories you made, with the comments each one covers.'
        ];
  return [
    `I'm refining feedback from testing the prototype "${projectName}". Below ${comments} reviewers left on its pages, under any themes the team gave them.`,
    "",
    ...ask,
    "",
    "Ask me if anything is unclear before you write."
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
  mode: RefineMode;
  /** A link's label, for a project with more than one link; null leaves links unnamed. */
  linkLabel: ((linkId: string) => string) | null;
  now: Date;
}): { product: string; title: string; body: string; threadIds: string[] } {
  const ordered = refinementOrder(input.threads).slice(0, MAX_REFINE_THREADS);
  // The opening says how many comments follow, which is only known once they are fitted in: room is kept for the
  // longest it could be.
  const room = Math.max(opening(input.projectName, ordered.length, input.mode).length, opening(input.projectName, 1, input.mode).length);
  const sections: string[] = [];
  let used = room;
  let theme: string | undefined;
  const included: string[] = [];
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
    included.push(thread.id);
  }
  const left = ordered.length - included.length;
  const note =
    left === 0 ? "" : `\n\n(${left === 1 ? "1 more comment was" : `${left} more comments were`} left out to keep this message short enough to send.)`;
  return {
    product: DEFAULT_PRODUCT,
    title: `Refine feedback: ${input.projectName}, ${ukLongDate(input.now)}`,
    body: `${opening(input.projectName, included.length, input.mode)}${sections.join("")}${note}`,
    // The threads the message lists, which alone are refined in the conversation it starts.
    threadIds: included
  };
}
