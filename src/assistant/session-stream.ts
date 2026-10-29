import type { EventHub } from "../realtime/hub.ts";
import { type OnOpen, sseEvent } from "../realtime/sse.ts";
import type { LookupFrame } from "./lookup-store.ts";
import type { Wake } from "./store.ts";
import type { UploadDeletion } from "./upload-disk.ts";
import type { WelshFrame } from "./welsh-store.ts";

export interface SessionStreamSources {
  hub: EventHub;
  /** Resolves once the pod's `LISTEN` is active, so every NOTIFY committed after it reaches the hub. */
  ready: () => Promise<void>;
  /** Every pending wake of the assistant, oldest first. */
  wakes: () => Promise<Wake[]>;
  /** The conversation's pending wake, `undefined` when it has none, or `null` when the conversation is gone. */
  wake: (conversationId: string) => Promise<Wake | undefined | null>;
  /** The files the owner has asked the pod to delete and it has not yet reported gone, grouped by conversation. */
  deletions: () => Promise<UploadDeletion[]>;
  /** The lookup to send the pod, `undefined` once it is answered or when it is not this assistant's. */
  lookup: (lookupId: string) => Promise<LookupFrame | undefined>;
  /** The Welsh job to send the pod, `undefined` once it is answered or when it is not this assistant's. */
  welsh: (jobId: string) => Promise<WelshFrame | undefined>;
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

export function lookupFrame(lookup: LookupFrame): string {
  return sseEvent({ event: "lookup", data: JSON.stringify(lookup) });
}

export function welshFrame(job: WelshFrame): string {
  return sseEvent({ event: "welsh", data: JSON.stringify(job) });
}

export function deleteUploadsFrame(deletion: UploadDeletion): string {
  return sseEvent({ event: "delete_uploads", data: JSON.stringify(deletion) });
}

/**
 * What `GET /api/virtual/{id}/sessions` sends an assistant's pod: every pending wake and every outstanding file
 * deletion on connect, then a wake as each conversation needs a session, an interrupt as the person stops an answer,
 * a deletion as each is asked for, and a close as each conversation is deleted.
 *
 * Opened in the same order as the agent stream (subscribe, wait for `LISTEN`, then replay), so nothing committed
 * around the replay is missed. A wake is sent at most once per connection for each session id, and again on the
 * next connection until a session registers, which is what clears it. A `resync` replays, since NOTIFYs sent while
 * the listener was down are gone. A failed read ends the stream, and the pod's reconnect replays.
 *
 * A deletion replays on both, unlike a wake only in that nothing de-duplicates it: it names a state to reach, it is
 * idempotent — a file that is not there is a deletion that has already happened — and the pod's next report is what
 * stops it being read at all. A file somebody asked to delete while the pod was restarting must still go.
 *
 * A lookup is read and sent as soon as it is asked for, beside the queue rather than behind it, because somebody is
 * typing and waiting for it; and like an interrupt it is never replayed, since the search it was for has been replaced
 * by the time another stream opens. A read that fails loses that one lookup, which the browser reports as a timeout,
 * rather than ending the stream. A Welsh job is sent the same way: once, as it is started, and never replayed — a job
 * lost to a reconnect times out, and the person starts it again, which is safer than running a pull request twice.
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

    const sendDeletions = async () => {
      for (const deletion of await sources.deletions()) {
        if (open) {
          send(deleteUploadsFrame(deletion));
        }
      }
    };

    const replay = async () => {
      for (const wake of await sources.wakes()) {
        emit(wake);
      }
      await sendDeletions();
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
      } else if (event.type === "assistant_lookup" && event.virtual_agent_id === virtualAgentId) {
        sources.lookup(event.lookup_id).then(
          (lookup) => {
            if (open && lookup !== undefined) {
              send(lookupFrame(lookup));
            }
          },
          () => undefined
        );
      } else if (event.type === "assistant_welsh" && event.virtual_agent_id === virtualAgentId) {
        sources.welsh(event.job_id).then(
          (job) => {
            if (open && job !== undefined) {
              send(welshFrame(job));
            }
          },
          () => undefined
        );
      } else if (event.type === "assistant_uploads" && event.virtual_agent_id === virtualAgentId) {
        enqueue(sendDeletions);
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
