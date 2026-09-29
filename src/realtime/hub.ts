import type { HubEvent } from "./events.ts";

export type HubListener = (event: HubEvent) => void;

/** One pod's fan-out: the NOTIFY listener publishes, and every open SSE stream subscribes. */
export interface EventHub {
  publish: (event: HubEvent) => void;
  /** Returns the unsubscribe function. */
  subscribe: (listener: HubListener) => () => void;
  size: () => number;
}

export function createEventHub(): EventHub {
  const listeners = new Set<HubListener>();

  return {
    publish: (event) => {
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          // One broken stream must not stop the event reaching the others.
          console.warn(`a hub listener threw on a ${event.type} event: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    size: () => listeners.size
  };
}
