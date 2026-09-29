/**
 * How many SSE streams one person may hold open on this pod. Each stream holds a hub subscription and queues work on
 * the pod's Prisma pool, so an unbounded number from one person could starve everyone else.
 *
 * A browser tab holds one UI stream, and a running Claude session one agent stream.
 */
export const UI_STREAMS_PER_PERSON = 20;
export const AGENT_STREAMS_PER_PERSON = 50;

export interface StreamSlots {
  /** Takes a slot for `oid` and returns the idempotent function that gives it back, or `undefined` at the limit. */
  take: (oid: string) => (() => void) | undefined;
  held: (oid: string) => number;
}

export function createStreamSlots(limit: number): StreamSlots {
  const counts = new Map<string, number>();
  return {
    take(oid) {
      const current = counts.get(oid) ?? 0;
      if (current >= limit) {
        return undefined;
      }
      counts.set(oid, current + 1);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const remaining = (counts.get(oid) ?? 1) - 1;
        if (remaining > 0) {
          counts.set(oid, remaining);
        } else {
          counts.delete(oid);
        }
      };
    },
    held: (oid) => counts.get(oid) ?? 0
  };
}

export interface StreamLimits {
  ui: StreamSlots;
  agent: StreamSlots;
}

/** On `globalThis`, like the realtime hub, so every module graph Next builds counts against the same slots. */
const globalForStreamLimits = globalThis as unknown as { agentHubStreamLimits?: StreamLimits };

export function streamLimits(): StreamLimits {
  if (globalForStreamLimits.agentHubStreamLimits === undefined) {
    globalForStreamLimits.agentHubStreamLimits = {
      ui: createStreamSlots(UI_STREAMS_PER_PERSON),
      agent: createStreamSlots(AGENT_STREAMS_PER_PERSON)
    };
  }
  return globalForStreamLimits.agentHubStreamLimits;
}
