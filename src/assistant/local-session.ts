import type { AgentStatus } from "../realtime/events.ts";

/**
 * Which of three states the session of a chat on the person's own computer is in: answering, connected and waiting,
 * or not connected at all. The agent's status in the words the mark says it in, so the colour, the tooltip and the
 * row's name are three renderings of one value rather than three mappings that can drift apart.
 */
export type LocalSession = "ready" | "working" | "disconnected";

/**
 * The three states the laptop mark shows, named for what they mean to a person reading the list.
 *
 * Coloured `idle` green, `busy` the same green with a badge and `offline` grey. That makes `idle` the welcoming state:
 * `offline` is a heartbeat gone for 90 seconds and so the only one that is really "not connected", while `idle` is a
 * live session with nothing in hand, which is when it will answer you fastest. `busy` is mid-turn: still connected, so
 * still green, but badged because a message sent then waits.
 *
 * Its own module, importing nothing at run time, because both ends read it: the server render marks the list with it
 * and the sidebar maps a live `agent_status` frame through it, so the two cannot name one status differently.
 */
export const LOCAL_SESSION: Readonly<Record<AgentStatus, LocalSession>> = { idle: "ready", busy: "working", offline: "disconnected" };
