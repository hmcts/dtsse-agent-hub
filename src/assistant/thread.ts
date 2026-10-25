import type { DeliveryView } from "../messages/direct-thread.ts";
import type { AgentStatus } from "../realtime/events.ts";
import { byCodePoint } from "../topics/slug.ts";
import type { ConversationItem } from "../transcripts/conversation.ts";
import { productLabel } from "./products.ts";
import type { MessageAttachment } from "./upload-store.ts";

/**
 * An assistant conversation as a non-technical reader sees it: what they wrote, what the assistant answered, and
 * where they changed the product. Tool calls, their results and system lines are left out; what the assistant is
 * doing shows as one friendly line while it works. Pure, so the server's first render and the browser's live
 * updates agree.
 */

export type ThreadItem =
  /**
   * `attachments` is always an array here, so the view never has to decide what a missing one means. Only the name and
   * size are shown: the hub drops the bytes once the assistant's machine has them, so there is nothing to hand back.
   */
  | { type: "user"; key: string; at: string; text: string; delivery: DeliveryView | null; attachments: MessageAttachment[] }
  | { type: "assistant"; key: string; at: string; text: string }
  | { type: "product"; key: string; at: string; label: string };

export interface ProductMark {
  product: string;
  at: string;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "object" && content !== null && "text" in content && typeof content.text === "string") {
    const text = content.text.trim();
    return text === "" ? undefined : text;
  }
  return undefined;
}

/** By time, then by kind so a product change at the same instant as a message sits before it. */
function byTime(left: ThreadItem, right: ThreadItem): number {
  const rank = (item: ThreadItem) => (item.type === "product" ? 0 : 1);
  return byCodePoint(left.at, right.at) || rank(left) - rank(right);
}

export function threadItems(items: readonly ConversationItem[], products: readonly ProductMark[] = []): ThreadItem[] {
  const thread: ThreadItem[] = [];
  for (const item of items) {
    if (item.type === "message") {
      const message = item.message;
      thread.push(
        message.author.type === "user"
          ? { type: "user", key: item.key, at: item.at, text: message.body, delivery: message.delivery, attachments: message.attachments ?? [] }
          : { type: "assistant", key: item.key, at: item.at, text: message.body }
      );
    } else if (item.entry.role === "assistant") {
      const text = textOf(item.entry.content);
      if (text !== undefined) {
        thread.push({ type: "assistant", key: item.key, at: item.at, text });
      }
    }
  }
  const marks = products.map((mark): ThreadItem => ({ type: "product", key: `p${mark.at}`, at: mark.at, label: productLabel(mark.product) }));
  return [...thread, ...marks].sort(byTime);
}

/** What Claude Code's tools do, in words for someone who has never seen one. */
const ACTIVITIES: Readonly<Record<string, string>> = {
  Read: "Reading",
  Grep: "Searching",
  Glob: "Searching",
  Bash: "Checking",
  WebFetch: "Looking things up",
  WebSearch: "Looking things up",
  Edit: "Writing",
  Write: "Writing",
  NotebookEdit: "Writing",
  Task: "Working through it",
  Agent: "Working through it",
  Skill: "Looking at the guidance",
  TodoWrite: "Planning"
};

export function activityLabel(toolName: string | undefined): string {
  return (toolName === undefined ? undefined : ACTIVITIES[toolName]) ?? "Thinking";
}

export type SessionState = "starting" | "live" | "queued" | null;

export type Progress =
  | { state: "idle" }
  | { state: "waking"; label: string }
  /** `helpers` is how many subagents the answer is waiting on, and 0 whenever that cannot be told. */
  | { state: "working"; label: string; helpers: number };

/** The tools that hand work to a subagent. Both names are in use: `Task` is the older one, `Agent` the current. */
const HELPER_TOOLS: readonly string[] = ["Task", "Agent"];

/**
 * The most helpers reported. Claude Code refuses more than 20 subagents at once, so a larger number can only be a
 * launch whose result this could not pair, and a wrong big number is worse than a capped one.
 */
export const MAX_HELPERS = 20;

/**
 * How many subagents the assistant launched since `since` and is still waiting on: one counted per `Task`/`Agent`
 * call with no result yet. `tool_result` is written against the call it answers, so a call with no matching result
 * is a subagent still running.
 *
 * 0 rather than a guess in two cases, because over-reporting is the one error a person would act on:
 *
 * - a `tool_result` in the window was redacted, which drops the `tool_use_id` it answers (`scrub` in the published
 *   client keeps the id only for a `tool_use`). With one result unpairable, no count here is trustworthy;
 * - a subagent launched to run in the background, whose result is written at once rather than on completion. That
 *   reads as finished, which is the honest answer to what this line says: the answer is not waiting on it.
 */
export function runningHelpers(items: readonly ConversationItem[], since: string): number {
  const launched = new Set<string>();
  const answered = new Set<string>();
  for (const item of items) {
    if (item.type !== "entry" || byCodePoint(item.at, since) < 0) {
      continue;
    }
    const { role, content } = item.entry;
    if (
      role === "tool_use" &&
      "id" in content &&
      typeof content.id === "string" &&
      "name" in content &&
      typeof content.name === "string" &&
      HELPER_TOOLS.includes(content.name)
    ) {
      launched.add(content.id);
    } else if (role === "tool_result") {
      if (!("tool_use_id" in content)) {
        return 0;
      }
      answered.add(content.tool_use_id);
    }
  }
  let running = 0;
  for (const id of launched) {
    if (!answered.has(id)) {
      running += 1;
    }
  }
  return Math.min(running, MAX_HELPERS);
}

/**
 * Whether the assistant is working on the person's last message, and what to tell them.
 *
 * The session's own `busy` is what says it is working: its hooks set it as a turn starts and clear it as the turn
 * ends, however it ended, so an answer that failed or was stopped leaves this line rather than spinning forever.
 * Before that, a message still queued on the hub is on its way, and an offline agent is one the pod is starting.
 * Nothing is said in any other case: a line claiming work nobody is doing is worse than no line.
 */
export function progress(items: readonly ConversationItem[], thread: readonly ThreadItem[], agentStatus: AgentStatus, session: SessionState): Progress {
  const spoken = thread.filter((item) => item.type !== "product");
  const last = spoken.at(-1);
  const asked = last?.type === "user" ? last : undefined;
  if (asked !== undefined && asked.delivery !== "expired" && agentStatus === "offline") {
    return { state: "waking", label: session === "queued" ? "Waiting for a free assistant…" : "Starting your assistant…" };
  }
  if (agentStatus === "busy") {
    const since = last?.at ?? "";
    const tool = [...items].reverse().find((item) => item.type === "entry" && item.entry.role === "tool_use" && byCodePoint(item.at, since) >= 0);
    const name = tool?.type === "entry" && typeof tool.entry.content === "object" && "name" in tool.entry.content ? tool.entry.content.name : undefined;
    return { state: "working", label: activityLabel(typeof name === "string" ? name : undefined), helpers: runningHelpers(items, since) };
  }
  if (asked?.delivery === "queued") {
    return { state: "waking", label: "Sending your message…" };
  }
  return { state: "idle" };
}

function helperCount(helpers: number): string {
  return helpers === 1 ? "1 helper" : `${helpers} helpers`;
}

/** The whole line as it is shown: the activity, and the helpers the answer is waiting on when it has any. */
export function progressLabel(doing: Progress): string {
  if (doing.state === "idle") {
    return "";
  }
  if (doing.state === "waking" || doing.helpers === 0) {
    return doing.label;
  }
  return `${doing.label} · ${helperCount(doing.helpers)} running`;
}

/**
 * What a screen reader is told. Deliberately not the activity: that changes with every tool call, a few seconds
 * apart, and reading each one out would talk over the person for as long as the answer takes. Only the facts that
 * settle — that it is working, how many helpers it has, and that it has finished — are announced.
 */
export function progressAnnouncement(doing: Progress): string {
  if (doing.state === "idle") {
    return "";
  }
  if (doing.state === "waking") {
    return doing.label.replace(/…$/, "");
  }
  return doing.helpers === 0 ? "Working on your answer" : `Working on your answer, with ${helperCount(doing.helpers)} running`;
}
