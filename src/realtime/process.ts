import { resolveDatabaseUrl } from "../store/database-url.ts";
import { createEventHub, type EventHub } from "./hub.ts";
import { type Listener, startListener } from "./listener.ts";

export interface Realtime {
  hub: EventHub;
  listener: Listener;
}

/**
 * The pod's hub and its one LISTEN connection. `instrumentation.ts` starts it at boot, after the secrets load, so
 * `LISTEN` is usually active before the first stream opens; a stream that opens sooner waits for `ready()`. On
 * `globalThis` because Next builds separate module graphs for `instrumentation.ts` and the route handlers, and each
 * would otherwise hold its own listener.
 */
const globalForRealtime = globalThis as unknown as { agentHubRealtime?: Realtime };

export function realtime(): Realtime {
  if (globalForRealtime.agentHubRealtime === undefined) {
    const hub = createEventHub();
    globalForRealtime.agentHubRealtime = { hub, listener: startListener({ connectionString: resolveDatabaseUrl(), hub }) };
  }
  return globalForRealtime.agentHubRealtime;
}
