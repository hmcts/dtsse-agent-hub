import type { EventHub } from "../realtime/hub.ts";
import { type OnOpen, sseEvent } from "../realtime/sse.ts";
import type { Wake } from "./store.ts";

export interface SessionStreamSources {
  hub: EventHub;
  /** Resolves once the pod's `LISTEN` is active, so every NOTIFY committed after it reaches the hub. */
  ready: () => Promise<void>;
  /** Every pending wake of the assistant, oldest first. */
  wakes: () => Promise<Wake[]>;
  /** The conversation's pending wake, `undefined` when it has none, or `null` when the conversation is gone. */
  wake: (conversationId: string) => Promise<Wake | undefined | null>;
}

export function wakeFrame(wake: Wake): string {
  return sseEvent({ event: "wake", data: JSON.stringify(wake) });
}

export function closeFrame(conversationId: string): string {
  return sseEvent({ event: "close", data: JSON.stringify({ conversation_id: conversationId }) });
}

export function interruptFrame(conversationId: string): string {
  return sseEvent({ event: "interrupt", data: JSON.stringify({ conversation_id: conversationId }) });
}

/**
 * What `GET /api/virtual/{id}/sessions` sends an assistant's pod: every pending wake on connect, then a wake as each
 * conversation needs a session, an interrupt as the person stops an answer, and a close as each is deleted.
 *
 * Opened in the same order as the agent stream (subscribe, wait for `LISTEN`, then replay), so nothing committed
 * around the replay is missed. A wake is sent at most once per connection for each session id, and again on the
 * next connection until a session registers, which is what clears it. A `resync` replays, since NOTIFYs sent while
 * the listener was down are gone. A failed read ends the stream, and the pod's reconnect replays.
 *
 * An interrupt is the exception to all of that: it is neither replayed on connect nor resent on a `resync`, because
 * it names no state to reach but a turn to end, and the turn a missed one would have ended is over by the time
 * another stream opens.
 */
export function sessionStream(virtualAgentId: string, sources: SessionStreamSources): OnOpen {
  return (send, fail) => {
    const sent = new Set<string>();
    let chain: Promise<void> = Promise.resolve();
    let open = true;

    function emit(wake: Wake): void {
      const key = `${wake.conversation_id}:${wake.session_id}`;
      if (open && !sent.has(key)) {
        sent.add(key);
        send(wakeFrame(wake));
      }
    }

    function enqueue(work: () => Promise<void>): void {
      chain = chain
        .then(async () => {
          if (open) {
            await work();
          }
        })
        .catch((error: unknown) => {
          open = false;
          fail(new Error(`a sessions stream could not read its wakes: ${error instanceof Error ? error.message : String(error)}`));
        });
    }

    const replay = async () => {
      for (const wake of await sources.wakes()) {
        emit(wake);
      }
    };

    const unsubscribe = sources.hub.subscribe((event) => {
      if (event.type === "assistant_conversation" && event.virtual_agent_id === virtualAgentId) {
        enqueue(async () => {
          const wake = await sources.wake(event.conversation_id);
          if (wake === null) {
            if (open) {
              send(closeFrame(event.conversation_id));
            }
          } else if (wake !== undefined) {
            emit(wake);
          }
        });
      } else if (event.type === "assistant_stop" && event.virtual_agent_id === virtualAgentId) {
        // Sent straight out rather than through `enqueue`: there is nothing to read, and a stop that waited behind a
        // queued wake's database round trip would reach the pane later than the turn it was meant to end.
        if (open) {
          send(interruptFrame(event.conversation_id));
        }
      } else if (event.type === "resync") {
        enqueue(replay);
      }
    });

    enqueue(async () => {
      await sources.ready();
      await replay();
    });

    return () => {
      open = false;
      unsubscribe();
    };
  };
}
