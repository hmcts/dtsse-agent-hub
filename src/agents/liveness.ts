import type { AgentStatus } from "../realtime/events.ts";

/** An agent silent for longer than this is marked offline by the sweep. */
export const OFFLINE_AFTER_SECONDS = 90;

/**
 * How long a direct message waits for an offline agent before the sweep marks it `expired`. Every session registers a
 * new agent, so a message to one that has ended would otherwise stay queued for good; a day is long enough for a
 * laptop left asleep overnight to come back and still receive it.
 */
export const EXPIRE_AFTER_SECONDS = 24 * 60 * 60;

const LIVE_WINDOW_MS = OFFLINE_AFTER_SECONDS * 1000;

/** When the UI last knew an agent to be heard from, as epoch milliseconds. */
export interface Heard {
  status: AgentStatus;
  at: number;
}

/**
 * When a live agent was last heard from. Heartbeats that do not change the status are not streamed, so the time the
 * page was rendered with only grows older while the agent keeps talking; the sweep's guarantee bounds it instead.
 */
export function lastHeard(heard: Heard, now: number): number {
  return heard.status === "offline" ? heard.at : Math.max(heard.at, now - LIVE_WINDOW_MS);
}

/**
 * The state after a status arrives on the stream at `now`. A live status is only announced by a register or heartbeat
 * that has just landed; going offline keeps the last time the agent was known to be heard from.
 */
export function onStatus(heard: Heard, status: AgentStatus, now: number): Heard {
  return { status, at: status === "offline" ? lastHeard(heard, now) : now };
}
