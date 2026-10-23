import type { EventHub } from "../realtime/hub.ts";
import { type OnOpen, sseEvent } from "../realtime/sse.ts";
import type { JiraExportRequest } from "./jira-store.ts";
import type { Wake } from "./store.ts";

export interface SessionStreamSources {
  hub: EventHub;
  /** Resolves once the pod's `LISTEN` is active, so every NOTIFY committed after it reaches the hub. */
  ready: () => Promise<void>;
  /** Every pending wake of the assistant, oldest first. */
  wakes: () => Promise<Wake[]>;
  /** The conversation's pending wake, `undefined` when it has none, or `null` when the conversation is gone. */
  wake: (conversationId: string) => Promise<Wake | undefined | null>;
  /** Every pending Jira export of the assistant's conversations, oldest first. */
  jiraExports: () => Promise<JiraExportRequest[]>;
  /** The conversation's pending Jira export, if it has one. */
  jiraExport: (conversationId: string) => Promise<JiraExportRequest | undefined>;
}

export function wakeFrame(wake: Wake): string {
  return sseEvent({ event: "wake", data: JSON.stringify(wake) });
}

export function closeFrame(conversationId: string): string {
  return sseEvent({ event: "close", data: JSON.stringify({ conversation_id: conversationId }) });
}

export function jiraExportFrame(request: JiraExportRequest): string {
  return sseEvent({ event: "jira_export", data: JSON.stringify(request) });
}

/**
 * What `GET /api/virtual/{id}/sessions` sends an assistant's pod: every pending wake and Jira export on connect,
 * then a wake as each conversation needs a session, an export as each is asked for, and a close as each is deleted.
 *
 * Opened in the same order as the agent stream (subscribe, wait for `LISTEN`, then replay), so nothing committed
 * around the replay is missed. A wake is sent at most once per connection for each session id, and again on the
 * next connection until a session registers, which is what clears it; an export likewise for each export id, until
 * the pod reports it. A `resync` replays, since NOTIFYs sent while the listener was down are gone. A failed read
 * ends the stream, and the pod's reconnect replays.
 */
export function sessionStream(virtualAgentId: string, sources: SessionStreamSources): OnOpen {
  return (send, fail) => {
    const sent = new Set<string>();
    const exports = new Set<string>();
    let chain: Promise<void> = Promise.resolve();
    let open = true;

    function emit(wake: Wake): void {
      const key = `${wake.conversation_id}:${wake.session_id}`;
      if (open && !sent.has(key)) {
        sent.add(key);
        send(wakeFrame(wake));
      }
    }

    function emitExport(request: JiraExportRequest): void {
      if (open && !exports.has(request.export_id)) {
        exports.add(request.export_id);
        send(jiraExportFrame(request));
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
      for (const request of await sources.jiraExports()) {
        emitExport(request);
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
            return;
          }
          if (wake !== undefined) {
            emit(wake);
          }
          const request = await sources.jiraExport(event.conversation_id);
          if (request !== undefined) {
            emitExport(request);
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
