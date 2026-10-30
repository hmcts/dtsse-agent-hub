import type { DeliveryView } from "../messages/direct-thread.ts";
import type { QuestionView } from "../questions/views.ts";
import type { AgentStatus } from "../realtime/events.ts";
import { byCodePoint } from "../topics/slug.ts";
import { type ConversationItem, toolSummary } from "../transcripts/conversation.ts";
import { taskFailed, taskNotifications } from "../transcripts/task-notification.ts";
import { productLabel } from "./products.ts";
import type { MessageAttachment } from "./upload-store.ts";

/**
 * An assistant conversation as a non-technical reader sees it: what they wrote, what the assistant answered, any
 * question it asked them, and where they changed the product. Tool calls, their results and system lines are left
 * out; what the assistant is doing shows as one friendly line while it works. Pure, so the server's first render and
 * the browser's live updates agree.
 *
 * A chat that is a Claude Code session on the person's own computer reads differently, which is what `local` asks
 * for: the words it is answering were typed at that laptop rather than sent from here, so they are in the transcript
 * rather than in the hub's thread, and the person reading is the developer whose session it is, so the tool calls
 * are theirs to see. Everything else is the same thread.
 */

export type ThreadItem =
  /**
   * `attachments` is always an array here, so the view never has to decide what a missing one means. Each carries the
   * instant the hub stops holding its bytes, which is what the chip needs to know whether it can offer the file back.
   */
  | { type: "user"; key: string; at: string; text: string; delivery: DeliveryView | null; attachments: MessageAttachment[] }
  | { type: "assistant"; key: string; at: string; text: string }
  | { type: "product"; key: string; at: string; label: string }
  /**
   * A question the assistant asked, shown as a card with its options. The one thing in the thread the person acts on
   * rather than reads: until they answer, the assistant is waiting on them, which is why `progress` says nothing.
   */
  | { type: "question"; key: string; at: string; question: QuestionView }
  /** Where the person stopped an answer. Whatever the assistant had said by then stays above it. */
  | { type: "stopped"; key: string; at: string }
  /**
   * One tool call, shown only in a local chat: the tool's name and `toolSummary`'s one line of what it was given.
   * What came back is left out — a tool result is the session's working-out, and the row is here to say what it did.
   *
   * `failed` only where the result that answered this call said so. A result nobody can pair — a redacted one, which
   * keeps no `tool_use_id` — leaves every call it might have answered neutral, because marking a call failed on a
   * guess is worse than saying nothing about how it went.
   */
  | { type: "tool"; key: string; at: string; name: string; summary: string; failed: boolean }
  /**
   * A line the harness wrote into the session's user turns rather than the person: a slash command they ran, or a
   * background task reporting back. Local chats only, since a pod chat's user turns are all hub messages. Shown as a
   * quiet line, because the raw text is XML nobody typed.
   */
  | { type: "notice"; key: string; at: string; text: string; failed: boolean };

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

/** The text of a slash command's turn, or `undefined` when it is not one. */
function commandNotice(text: string): string | undefined {
  if (!text.startsWith("<command-name>")) {
    return undefined;
  }
  const field = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim() ?? "";
  const name = field("command-name");
  const args = field("command-args");
  return name === "" ? undefined : `Ran ${name}${args === "" ? "" : ` ${args}`}`;
}

/** Turns the harness writes as the user that carry nothing a person should read: a command's output and its caveat. */
const SILENT_TURNS = ["local-command-stdout", "local-command-stderr", "local-command-caveat", "system-reminder"];

/** The longest a notice is, so one monitor event or a skill's long arguments cannot fill the line. */
const NOTICE_LIMIT = 200;

/** One line, bounded: harness text can carry newlines and whole prompts. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NOTICE_LIMIT ? `${flat.slice(0, NOTICE_LIMIT - 1)}…` : flat;
}

/**
 * What a local chat's user turn is when the harness wrote it: notices to show, an empty list to show nothing, or
 * `undefined` when the person typed it.
 */
function harnessTurn(raw: string, truncated: boolean): { text: string; failed: boolean }[] | undefined {
  const text = raw.trim();
  const command = commandNotice(text);
  if (command !== undefined) {
    return [{ text: oneLine(command), failed: false }];
  }
  // Only a turn that is wholly one such block: a person quoting output at the start of their own prompt is not dropped.
  if (SILENT_TURNS.some((tag) => text.startsWith(`<${tag}>`) && text.endsWith(`</${tag}>`))) {
    return [];
  }
  return taskNotifications(text, { truncated })?.map((task) => ({
    text: oneLine(task.summary ?? task.event ?? "A background task finished"),
    failed: taskFailed(task.status)
  }));
}

/** A tool call the session made, with what came back. */
interface ToolCall {
  key: string;
  at: string;
  /** `undefined` for a redacted call that kept neither its id nor its name, which nothing can be paired to. */
  id: string | undefined;
  name: string | undefined;
  input: unknown;
  /** `undefined` while nothing has answered the call, which for a subagent means it is still running. */
  result: { failed: boolean } | undefined;
}

/** What a tool call whose name was redacted away is called, so the row still says something happened. */
const UNNAMED_TOOL = "Tool call";

/**
 * The tool calls in `items` at or after `since`, each paired with the result written against its `tool_use_id`, and
 * whether any result could not be paired at all.
 *
 * The one place that matching happens: both the rows a local chat shows and the count of subagents an answer is
 * waiting on are the same question of the same two roles, and a second matcher would be a second set of decisions
 * about redacted entries. A redacted `tool_use` keeps `{id, name, redacted}` and so still pairs and still names its
 * tool; a redacted `tool_result` keeps neither, so it is counted as unpaired and attached to nothing.
 */
function toolCalls(items: readonly ConversationItem[], since = ""): { calls: ToolCall[]; unpaired: boolean } {
  const calls: Omit<ToolCall, "result">[] = [];
  const results = new Map<string, { failed: boolean }>();
  let unpaired = false;
  for (const item of items) {
    if (item.type !== "entry" || byCodePoint(item.at, since) < 0) {
      continue;
    }
    const { role, content } = item.entry;
    if (role === "tool_use") {
      calls.push({
        key: item.key,
        at: item.at,
        id: "id" in content && typeof content.id === "string" ? content.id : undefined,
        name: "name" in content && typeof content.name === "string" ? content.name : undefined,
        input: "input" in content ? content.input : undefined
      });
    } else if (role === "tool_result") {
      if ("tool_use_id" in content) {
        results.set(content.tool_use_id, { failed: content.is_error });
      } else {
        unpaired = true;
      }
    }
  }
  return { calls: calls.map((call) => ({ ...call, result: call.id === undefined ? undefined : results.get(call.id) })), unpaired };
}

/** A local chat's tool rows, in the order the transcript recorded the calls. */
function toolRows(items: readonly ConversationItem[]): ThreadItem[] {
  return toolCalls(items).calls.map((call) => ({
    type: "tool",
    key: call.key,
    at: call.at,
    name: call.name ?? UNNAMED_TOOL,
    summary: toolSummary(call.input),
    failed: call.result?.failed === true
  }));
}

/**
 * By time, then by kind so a product change at the same instant as a message sits before it and a stop sits after
 * it: a stop is always something the person did to what was already on the screen.
 *
 * A tool call ranks with the words, which leaves the sort unable to separate it from the ones it shares an instant
 * with — one line of a session's log is read as several entries carrying the one timestamp. The sort is stable and
 * the rows are added after the words, which is the order such a line holds them in: the assistant says what it is
 * about to do, then does it.
 */
function byTime(left: ThreadItem, right: ThreadItem): number {
  const rank = (item: ThreadItem) => (item.type === "product" ? 0 : item.type === "stopped" ? 2 : 1);
  return byCodePoint(left.at, right.at) || rank(left) - rank(right);
}

/**
 * Whether the thread is waiting on the person to answer a question, rather than on the assistant to work.
 *
 * Two bounds, and the line is wrong without either. Only a question newer than the last thing the person said: an
 * unanswered card further up is one they read past and carried on from, and the assistant is free to be working on
 * whatever they said instead. And only one still `offered`: a card abandoned hours ago would otherwise go on
 * claiming the assistant is waiting on them, including while it is in fact working.
 */
function awaitingAnswer(thread: readonly ThreadItem[]): boolean {
  const said = thread.filter((item) => item.type === "user").at(-1);
  return thread.some((item) => item.type === "question" && item.question.offered && (said === undefined || byCodePoint(item.at, said.at) > 0));
}

/**
 * The thread, oldest first. `local` is whether the conversation is a session on the person's own computer, which is
 * what the two extra kinds of row hang on:
 *
 * - the person's own prompts, which that session typed into its own terminal and uploaded as `user` entries. A pod
 *   chat has none of its own — every word the person said there arrived as a hub message, which is already in the
 *   thread, and the `user` entry recording it is the session's echo of that same message. `conversationItems` drops
 *   the echo of a message on the page, but a page whose oldest entry is such an echo can have been read without the
 *   message that made it, so a pod chat is left exactly as it was rather than shown a bubble twice;
 * - a row per tool call. A pod chat is a plain-language conversation for someone who is not an engineer and shows
 *   none; a developer reading their own session is the one reader for whom "Searching" is less use than the search.
 *
 * `system` entries stay out either way: they are the compact summaries a long session writes to itself.
 */
export function threadItems(
  items: readonly ConversationItem[],
  products: readonly ProductMark[] = [],
  stops: readonly StopMark[] = [],
  local = false
): ThreadItem[] {
  const thread: ThreadItem[] = [];
  for (const item of items) {
    if (item.type === "message") {
      const message = item.message;
      thread.push(
        message.author.type === "user"
          ? { type: "user", key: item.key, at: item.at, text: message.body, delivery: message.delivery, attachments: message.attachments ?? [] }
          : { type: "assistant", key: item.key, at: item.at, text: message.body }
      );
    } else if (item.type === "question") {
      thread.push({ type: "question", key: item.key, at: item.at, question: item.question });
    } else if (item.entry.role === "assistant") {
      const text = textOf(item.entry.content);
      if (text !== undefined) {
        thread.push({ type: "assistant", key: item.key, at: item.at, text });
      }
    } else if (local && item.entry.role === "user") {
      // A prompt whose words were redacted is left out rather than shown as an empty bubble, as a wordless assistant
      // entry is: `textOf` answers nothing for the `{redacted}` content such an entry keeps.
      const text = textOf(item.entry.content);
      const harness = text === undefined ? undefined : harnessTurn(text, item.entry.truncated);
      if (harness !== undefined) {
        for (const [index, notice] of harness.entries()) {
          thread.push({ type: "notice", key: `${item.key}:${index}`, at: item.at, text: notice.text, failed: notice.failed });
        }
      } else if (text !== undefined) {
        // No delivery and no attachments: this is what was typed at the laptop, not a message the hub carried there.
        thread.push({ type: "user", key: item.key, at: item.at, text, delivery: null, attachments: [] });
      }
    }
  }
  const tools = local ? toolRows(items) : [];
  const marks = products.map((mark): ThreadItem => ({ type: "product", key: `p${mark.at}`, at: mark.at, label: productLabel(mark.product) }));
  const stopped = stops.map((mark): ThreadItem => ({ type: "stopped", key: `s${mark.at}`, at: mark.at }));
  return [...thread, ...tools, ...marks, ...stopped].sort(byTime);
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
  const { calls, unpaired } = toolCalls(items, since);
  if (unpaired) {
    return 0;
  }
  const running = calls.filter(
    (call) => call.name !== undefined && HELPER_TOOLS.includes(call.name) && call.result === undefined && !launchesInBackground(call)
  ).length;
  return Math.min(running, MAX_HELPERS);
}

/** A launch older than this is taken to have ended without telling anyone. */
const BACKGROUND_HELPER_WINDOW_MS = 60 * 60 * 1000;

const TASK_TOOL_USE_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/g;

/** Whether a tool call hands work to a subagent that runs in the background: its result comes back at launch. */
function launchesInBackground(call: Pick<ToolCall, "name" | "input">): boolean {
  return (
    call.name !== undefined &&
    HELPER_TOOLS.includes(call.name) &&
    typeof call.input === "object" &&
    call.input !== null &&
    "run_in_background" in call.input &&
    call.input.run_in_background === true
  );
}

/**
 * How many subagents launched to run in the background are still running, wherever in the conversation they began.
 *
 * Separate from `runningHelpers` because the two are different facts. That counts the subagents an answer is waiting
 * on, so it only looks at the current turn and only for calls with no result. A background launch is answered at once,
 * so it never looks running there, and it outlives the turn that started it: the session's status goes idle while the
 * work carries on, and nothing else on the page says so. A background launch is running until the harness reports it
 * back as a `<task-notification>` naming the call's `tool_use_id`.
 *
 * A launch with no report that is more than an hour old is not counted: a session that was
 * killed never sends one, and a chip claiming work for ever is worse than missing a very long task.
 */
export function backgroundHelpers(items: readonly ConversationItem[], now = Date.now()): number {
  const { calls } = toolCalls(items);
  const reported = new Set<string>();
  for (const item of items) {
    if (item.type === "entry" && item.entry.role === "user") {
      const text = textOf(item.entry.content);
      if (text?.startsWith("<task-notification>")) {
        for (const match of text.matchAll(TASK_TOOL_USE_ID)) {
          reported.add((match[1] ?? "").trim());
        }
      }
    }
  }
  const cutoff = now - BACKGROUND_HELPER_WINDOW_MS;
  const running = calls.filter(
    (call) =>
      call.id !== undefined &&
      launchesInBackground(call) &&
      // A launch that failed started nothing, so nothing will report back.
      call.result?.failed !== true &&
      !reported.has(call.id) &&
      !(Date.parse(call.at) < cutoff)
  ).length;
  return Math.min(running, MAX_HELPERS);
}

/**
 * The two wordings for a pod's session that is not there yet, read from here by both the line under the thread and
 * the one above the composer, so the same wait is never worded two ways on the one screen.
 */
const STARTING = "Starting your assistant…";
const QUEUED = "Waiting for a free assistant…";

/**
 * What to say about an offline agent the person's last message is waiting on.
 *
 * Three different things, and only one of them is ever true of a given chat. A pod's session is either being started
 * for it or waiting its turn for a slot on the pod — `sessionState` is the pod's supervisor saying which. A session
 * on somebody's laptop is neither: nothing starts it and there is no queue it could be in, so all that can be said is
 * that it is not connected, and `local` is checked first because `sessionState` is only ever written by a pod's
 * supervisor and so is null for every local chat — leaving the `queued` arm unreachable there rather than wrong.
 */
function wakingLabel(session: SessionState, local: boolean): string {
  if (local) {
    return "Waiting for your session to reconnect…";
  }
  return session === "queued" ? QUEUED : STARTING;
}

/**
 * Whether the assistant is working on the person's last message, and what to tell them.
 *
 * The session's own `busy` is what says it is working: its `UserPromptSubmit` hook sets it as a turn starts and its
 * `Stop` hook clears it as the turn ends. A turn the person interrupted runs no `Stop` hook at all, so the pod's
 * interrupt writes `idle` itself; without that, this line would spin for ever on a stopped answer. Before `busy`, a
 * message still queued on the hub is on its way, and an offline agent is one the pod is starting — or, for a local
 * chat, one that is simply not connected; see `wakingLabel`. Nothing is said in any other case: a line claiming work
 * nobody is doing is worse than no line.
 */
export function progress(
  items: readonly ConversationItem[],
  thread: readonly ThreadItem[],
  agentStatus: AgentStatus,
  session: SessionState,
  local = false
): Progress {
  // The words and the marks on them. A product change is not something either of them said, and nor is a tool row:
  // a local chat's thread ends on one for most of every answer, and reading that as the last thing to have happened
  // would take away the line saying the person's message is still waiting on a session that is not connected. What
  // the tool calls are read for is the activity itself, below, which takes them from `items` rather than from here.
  const spoken = thread.filter((item) => item.type !== "product" && item.type !== "tool");
  const last = spoken.at(-1);
  // Before `busy` is read, because the status is a few seconds behind the stop and until it catches up "Thinking…"
  // would sit directly under the line saying they stopped it. Only a mask over that window: what actually ends the
  // work is the pod's interrupt, which writes `idle` itself. Anything the session says after the stop is a later
  // item, so this stops standing the moment there is something to show.
  if (last?.type === "stopped") {
    return { state: "idle" };
  }
  // A question on screen is the person's turn. The session that asked it was denied the tool and ended its turn, but
  // its status can still read `busy` for a few seconds, and "Thinking…" under a card waiting for them to choose says
  // the opposite of what is true.
  if (awaitingAnswer(thread)) {
    return { state: "idle" };
  }
  const asked = last?.type === "user" ? last : undefined;
  if (asked !== undefined && asked.delivery !== "expired" && agentStatus === "offline") {
    return { state: "waking", label: wakingLabel(session, local) };
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

/**
 * A wait as it is read out rather than shown. The trailing ellipsis is punctuation for the eye — it says the line is
 * standing there — and a screen reader either says nothing for it or says "ellipsis", so it goes.
 */
function spoken(label: string): string {
  return label.replace(/…$/, "");
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
    return spoken(doing.label);
  }
  return doing.helpers === 0 ? "Working on your answer" : `Working on your answer, with ${helperCount(doing.helpers)} running`;
}

/**
 * Light words for the wait while a pod starts a session, shown in turn.
 *
 * Every one of them still says the assistant is starting, because the line is the only thing on the screen saying so:
 * somebody who reads one of these and nothing else has to come away with the truth. The first is what a person sees
 * for the first few seconds of most waits, and is the plainest.
 */
export const WARMING_QUIPS: readonly [string, ...string[]] = [
  "Warming up your assistant…",
  "Luring an assistant with tea and biscuits…",
  "Putting the kettle on while your assistant starts…",
  "Waking your assistant, which is not a morning person…",
  "Starting your assistant — it is just finding its glasses…"
];

/**
 * What a chat with no session behind it says. Not a wait at all: nothing has been asked to start one, so the line
 * says what will ask, which is the person sending something.
 */
const UNSTARTED = "Your assistant starts when you send a message.";

/** One wording each, so the words a person reads come from here rather than from a list built on every render. */
const QUEUED_WORDS: readonly [string, ...string[]] = [QUEUED];
const UNSTARTED_WORDS: readonly [string, ...string[]] = [UNSTARTED];

export interface SessionNotice {
  /** Which wait this is. `starting` is the one whose words rotate; the other two have one wording each. */
  state: "starting" | "queued" | "unstarted";
  /** The words to show, in the order they are shown. Never empty, so the view always has a line to draw. */
  words: readonly [string, ...string[]];
  /** What a screen reader is told: the state itself, once, and never the quip standing in for it on the screen. */
  announcement: string;
}

/**
 * Whether to say anything above the composer about the session behind this chat, and what.
 *
 * The gap this fills: a pod runs a bounded number of sessions and `/exit`s one after twenty idle minutes, so an old
 * conversation on a running pod has no session behind it, and until this nothing said so. The wake fires on the
 * composer being focused, which asked for a session silently; the person learnt that one was starting only when they
 * sent. So four states, worded for what each is:
 *
 * - `live` — nothing. There is a session and it will answer.
 * - `starting` — the quips, which is the one wait that is only ever a few seconds and nobody's fault.
 * - `queued` — the pod is at its cap and another chat has to give up its session first. Said plainly: this is a real
 *   wait with a cause, and a joke over it would hide both.
 * - `null` — no session and nothing starting one, which is what `reportSessions` writes for every conversation its
 *   pod's supervisor leaves out of a report. Says what will start one.
 *
 * Nothing at all in three cases. A chat on somebody's laptop has no pod, no supervisor and so no `sessionState` worth
 * reading, and `localOfflineNote` already says the one thing there is to say there — checked first, so the two can
 * never both be on the screen. An agent that is not `offline` has a session whatever a report yet to land says, and
 * is also the agent the composer's wake leaves alone. And anything `progress` is already saying is left to it: the
 * line under the thread and this one would otherwise both word the same wait, directly above and below each other.
 */
export function sessionNotice(session: SessionState, agentStatus: AgentStatus, doing: Progress, local = false): SessionNotice | null {
  if (local || agentStatus !== "offline" || doing.state !== "idle" || session === "live") {
    return null;
  }
  if (session === "starting") {
    return { state: "starting", words: WARMING_QUIPS, announcement: spoken(STARTING) };
  }
  if (session === "queued") {
    return { state: "queued", words: QUEUED_WORDS, announcement: spoken(QUEUED) };
  }
  return { state: "unstarted", words: UNSTARTED_WORDS, announcement: UNSTARTED };
}
