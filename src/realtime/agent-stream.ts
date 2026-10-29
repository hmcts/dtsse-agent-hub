import type { StreamedDirect } from "../messages/shape.ts";
import type { EventHub } from "./hub.ts";
import { type OnOpen, sseEvent } from "./sse.ts";

export interface AgentStreamSources {
  hub: EventHub;
  /** Resolves once the pod's `LISTEN` is active, so every NOTIFY committed after it reaches the hub. */
  ready: () => Promise<void>;
  /** Every delivery still queued for the agent, oldest first. */
  queued: () => Promise<StreamedDirect[]>;
  /** The message, if its delivery to the agent is still queued. */
  queuedOne: (messageId: bigint) => Promise<StreamedDirect | undefined>;
}

/** Ends every agent stream that reaches its lifetime: the client reconnects at once, and the replay resends anything unacked. */
export const RECONNECT_FRAME = sseEvent({ event: "reconnect", data: "{}" });

export function directFrame(direct: StreamedDirect): string {
  const data = { message: direct.message, from_owner: direct.from_owner, ...(direct.assistant === undefined ? {} : { assistant: direct.assistant }) };
  return sseEvent({ id: direct.message.id, event: "direct", data: JSON.stringify(data) });
}

/**
 * What `GET /api/agent/{agent_id}/stream` sends: every queued delivery on connect, then each new direct message to
 * the agent, and each post that tagged it, as its NOTIFY arrives. Both are the same `delivery` row and leave as the
 * same `direct` frame, so a client needs nothing new to receive a tagged post.
 *
 * The order on open is subscribe to the hub, wait for `LISTEN` to be active, then read the replay. A message
 * committed before the replay's read is in the replay; one committed after it is notified, because `LISTEN` was
 * already active. One that is both is sent once per connection, keyed by message id. Work is chained so frames
 * leave in the order they were decided.
 *
 * A `resync` from a reconnected listener replays again, since NOTIFYs sent while it was down are gone. A failed read
 * ends the stream: the message is still queued, and the client's reconnect replays it.
 */
export function agentStream(agentId: string, sources: AgentStreamSources): OnOpen {
  return (send, fail) => {
    const sent = new Set<string>();
    let chain: Promise<void> = Promise.resolve();
    let open = true;

    function emit(direct: StreamedDirect): void {
      if (open && !sent.has(direct.message.id)) {
        sent.add(direct.message.id);
        send(directFrame(direct));
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
          fail(new Error(`an agent stream could not read its deliveries: ${error instanceof Error ? error.message : String(error)}`));
        });
    }

    const replay = async () => {
      for (const message of await sources.queued()) {
        emit(message);
      }
    };

    const unsubscribe = sources.hub.subscribe((event) => {
      // A post that tagged this agent queued it a delivery, so from here on it is read, sent and acked exactly as a
      // direct message is: the two events differ only in how the stream recognises one of its own.
      if ((event.type === "direct" && event.target_agent_id === agentId) || (event.type === "tagged_post" && event.agent_id === agentId)) {
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
