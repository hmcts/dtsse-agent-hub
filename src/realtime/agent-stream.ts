import type { ApiMessage } from "../messages/shape.ts";
import type { EventHub } from "./hub.ts";
import { type OnOpen, sseEvent } from "./sse.ts";

export interface AgentStreamSources {
  hub: EventHub;
  /** Every delivery still queued for the agent, oldest first. */
  queued: () => Promise<ApiMessage[]>;
  /** The message, if its delivery to the agent is still queued. */
  queuedOne: (messageId: bigint) => Promise<ApiMessage | undefined>;
}

export function directFrame(message: ApiMessage): string {
  return sseEvent({ id: message.id, event: "direct", data: JSON.stringify({ message }) });
}

/**
 * What `GET /api/agent/{agent_id}/stream` sends: every queued delivery on connect, then each new direct message to
 * the agent as its NOTIFY arrives.
 *
 * The hub is subscribed to BEFORE the replay is read, so a message committed between the two is not missed; one
 * that is both replayed and notified is sent once. Work is chained so frames leave in the order they were decided.
 * A `resync` from a reconnected listener replays again, since NOTIFYs sent while it was down are gone.
 */
export function agentStream(agentId: string, sources: AgentStreamSources): OnOpen {
  return (send) => {
    const sent = new Set<string>();
    let chain: Promise<void> = Promise.resolve();
    let open = true;

    function emit(message: ApiMessage): void {
      if (open && !sent.has(message.id)) {
        sent.add(message.id);
        send(directFrame(message));
      }
    }

    function enqueue(work: () => Promise<void>): void {
      chain = chain.then(work).catch((error: unknown) => {
        console.warn(`an agent stream could not read its deliveries: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    const replay = async () => {
      for (const message of await sources.queued()) {
        emit(message);
      }
    };

    const unsubscribe = sources.hub.subscribe((event) => {
      if (event.type === "direct" && event.target_agent_id === agentId) {
        const messageId = BigInt(event.message_id);
        enqueue(async () => {
          if (!sent.has(event.message_id)) {
            const message = await sources.queuedOne(messageId);
            if (message !== undefined) {
              emit(message);
            }
          }
        });
      } else if (event.type === "resync") {
        enqueue(replay);
      }
    });

    enqueue(replay);

    return () => {
      open = false;
      unsubscribe();
    };
  };
}
