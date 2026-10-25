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
  | { type: "product"; key: string; at: string; label: string }
  /** Where the person stopped an answer. Whatever the assistant had said by then stays above it. */
  | { type: "stopped"; key: string; at: string };

export interface ProductMark {
  product: string;
  at: string;
}

export interface StopMark {
  at: string;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === "object" && content !== null && "text" in content && typeof content.text === "string") {
    const text = content.text.trim();
    return text === "" ? undefined : text;
  }
  return undefined;
}

/**
 * By time, then by kind so a product change at the same instant as a message sits before it and a stop sits after
 * it: a stop is always something the person did to what was already on the screen.
 */
function byTime(left: ThreadItem, right: ThreadItem): number {
  const rank = (item: ThreadItem) => (item.type === "product" ? 0 : item.type === "stopped" ? 2 : 1);
  return byCodePoint(left.at, right.at) || rank(left) - rank(right);
}

export function threadItems(items: readonly ConversationItem[], products: readonly ProductMark[] = [], stops: readonly StopMark[] = []): ThreadItem[] {
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
  const stopped = stops.map((mark): ThreadItem => ({ type: "stopped", key: `s${mark.at}`, at: mark.at }));
  return [...thread, ...marks, ...stopped].sort(byTime);
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

export type Progress = { state: "idle" } | { state: "waking"; label: string } | { state: "working"; label: string };

/**
 * Whether the assistant is still on the person's last message, and what to tell them: starting a session for it,
 * waiting for a free one, or working, with the latest tool call as the activity. Settled once an answer follows the
 * last message, unless the session says it is still busy.
 */
export function progress(items: readonly ConversationItem[], thread: readonly ThreadItem[], agentStatus: AgentStatus, session: SessionState): Progress {
  const spoken = thread.filter((item) => item.type !== "product");
  const last = spoken.at(-1);
  // A stop the person asked for settles the thread at once. The session's status takes a few seconds to catch up, and
  // until it does, "Thinking…" would sit directly under the line saying they stopped it. Anything the session says
  // after the stop is a later item, so this stops standing the moment there is something to show.
  if (last?.type === "stopped") {
    return { state: "idle" };
  }
  const waiting = last?.type === "user" && last.delivery !== "expired";
  if (!waiting && agentStatus !== "busy") {
    return { state: "idle" };
  }
  if (waiting && agentStatus === "offline") {
    return { state: "waking", label: session === "queued" ? "Waiting for a free assistant…" : "Starting your assistant…" };
  }
  const since = last?.at ?? "";
  const tool = [...items].reverse().find((item) => item.type === "entry" && item.entry.role === "tool_use" && byCodePoint(item.at, since) >= 0);
  const name = tool?.type === "entry" && typeof tool.entry.content === "object" && "name" in tool.entry.content ? tool.entry.content.name : undefined;
  return { state: "working", label: activityLabel(typeof name === "string" ? name : undefined) };
}
