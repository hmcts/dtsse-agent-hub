import { type AgentRef, canReadMessage, canViewAgent, canViewTranscript, type Grant } from "../access/rules.ts";
import type { LoadedThreadMessage } from "../messages/direct-thread.ts";
import type { Match, PostScope } from "../messages/feed.ts";
import type { ApiMessage } from "../messages/shape.ts";
import { loadMessage } from "../messages/store.ts";
import type { Database } from "../store/prisma.ts";
import type { HubEvent } from "./events.ts";
import type { EventHub } from "./hub.ts";
import type { Listener } from "./listener.ts";
import { sharedLoads } from "./shared-load.ts";
import { type OnOpen, type Send, sseEvent } from "./sse.ts";

/**
 * What `/api/ui/stream` sends one browser tab: the events on the hub that the viewer may see and the page asked for.
 *
 * - `post`: a post on the watched topics, matched `any` or `all`, or any post when the page watches `everything`.
 *   Posts are readable by everyone signed in.
 * - `agent_status`: a status change of any agent the viewer can see, for the sidebar's dots.
 * - `direct` and `delivery`: a message in the watched agent's thread, or a change to its delivery, when the viewer
 *   can still see that agent and read that message.
 * - `transcript`: the watched agent's transcript has new entries, up to `last_id`, when the viewer may still read
 *   it. Only the id is sent; the page reads the entries through `/api/ui/agents/{id}/transcript`.
 * - `resync`: the pod's listener reconnected and NOTIFYs may have been missed, a grant the viewer holds changed
 *   and the agents they may see with it, or the viewer saved or deleted a credential, perhaps from the CLI; either
 *   way the page should re-read. Also sent once `LISTEN` becomes active
 *   when the stream opened before it was, since anything committed until then was never notified.
 *
 * A post is read once per pod and shared by every stream, since anyone may read it. The viewer's grants are read
 * once per stream and read again after a `grant` event naming them as grantee, so a revocation stops the events
 * after it rather than the next connection. Work is chained so frames leave in the order the hub published them.
 */

export interface UiWatch {
  /** Normalised slugs, or `everything` for every post; empty watches no posts. */
  topics: PostScope;
  match: Match;
  /** The agent whose thread the page shows, already checked visible when the stream opened. */
  agent: AgentRef | null;
}

export interface UiStreamSources {
  hub: EventHub;
  listener: Pick<Listener, "ready" | "connected">;
  viewerOid: string;
  /** Every grant the viewer holds. `uiStream` caches it until a `grant` event names the viewer. */
  grants: () => Promise<Grant[]>;
  post: (id: bigint) => Promise<ApiMessage | undefined>;
  direct: (id: bigint) => Promise<LoadedThreadMessage | undefined>;
}

const RESYNC = sseEvent({ event: "resync", data: "{}" });

/** Posts are never edited, so the TTL only bounds how long the pod holds one. */
const SHARED_POST_TTL_MS = 10_000;

const globalForUiPosts = globalThis as unknown as { agentHubUiPosts?: (id: bigint) => Promise<ApiMessage | undefined> };

/** The pod's one post loader for every UI stream, so a post event costs one read however many tabs are open. */
export function sharedPostLoader(db: Database): (id: bigint) => Promise<ApiMessage | undefined> {
  globalForUiPosts.agentHubUiPosts ??= sharedLoads((id: bigint) => loadMessage(db, id), { ttlMs: SHARED_POST_TTL_MS });
  return globalForUiPosts.agentHubUiPosts;
}

export function matchesTopics(messageTopics: readonly string[], watch: Pick<UiWatch, "topics" | "match">): boolean {
  const topics = watch.topics;
  if (topics === "everything") {
    return true;
  }
  if (topics.length === 0) {
    return false;
  }
  return watch.match === "all" ? topics.every((topic) => messageTopics.includes(topic)) : topics.some((topic) => messageTopics.includes(topic));
}

/** The frame an event becomes for this viewer, or `undefined` when it is not theirs to see. */
export async function selectFrame(event: HubEvent, watch: UiWatch, sources: Omit<UiStreamSources, "hub" | "listener">): Promise<string | undefined> {
  switch (event.type) {
    case "post": {
      if (watch.topics !== "everything" && watch.topics.length === 0) {
        return undefined;
      }
      const message = await sources.post(BigInt(event.message_id));
      if (message === undefined || message.kind !== "post" || !matchesTopics(message.topics, watch)) {
        return undefined;
      }
      return sseEvent({ id: message.id, event: "post", data: JSON.stringify({ message }) });
    }
    case "agent_status": {
      if (!canViewAgent(sources.viewerOid, { id: event.agent_id, ownerOid: event.owner_oid }, await sources.grants())) {
        return undefined;
      }
      return sseEvent({ event: "agent_status", data: JSON.stringify({ agent_id: event.agent_id, status: event.status }) });
    }
    case "direct": {
      const agent = watch.agent;
      if (agent === null || (event.target_agent_id !== agent.id && event.author_agent_id !== agent.id)) {
        return undefined;
      }
      const grants = await sources.grants();
      if (!canViewAgent(sources.viewerOid, agent, grants)) {
        return undefined;
      }
      const loaded = await sources.direct(BigInt(event.message_id));
      if (loaded === undefined || !canReadMessage(sources.viewerOid, loaded.ref, grants)) {
        return undefined;
      }
      return sseEvent({ id: loaded.message.id, event: "direct", data: JSON.stringify({ message: loaded.message }) });
    }
    case "delivery": {
      const agent = watch.agent;
      if (agent === null || event.agent_id !== agent.id || !canViewAgent(sources.viewerOid, agent, await sources.grants())) {
        return undefined;
      }
      return sseEvent({ event: "delivery", data: JSON.stringify({ message_id: event.message_id, state: event.state }) });
    }
    case "transcript": {
      const agent = watch.agent;
      if (agent === null || event.agent_id !== agent.id || !canViewTranscript(sources.viewerOid, agent, await sources.grants())) {
        return undefined;
      }
      return sseEvent({ event: "transcript", data: JSON.stringify({ agent_id: event.agent_id, last_id: event.last_id }) });
    }
    case "grant":
      return event.grantee_oid === sources.viewerOid ? RESYNC : undefined;
    case "credential":
      return event.owner_oid === sources.viewerOid ? RESYNC : undefined;
    case "resync":
      return RESYNC;
  }
}

/** The viewer's grants, read on first use and again after `invalidate`. A failed read is not kept. */
export function cachedGrants(load: () => Promise<Grant[]>): { get: () => Promise<Grant[]>; invalidate: () => void } {
  let current: Promise<Grant[]> | undefined;
  return {
    get: () => {
      if (current === undefined) {
        const attempt = load();
        current = attempt;
        attempt.catch(() => {
          if (current === attempt) {
            current = undefined;
          }
        });
      }
      return current;
    },
    invalidate: () => {
      current = undefined;
    }
  };
}

export function uiStream(watch: UiWatch, { hub, listener, ...sources }: UiStreamSources): OnOpen {
  return (send: Send) => {
    let chain: Promise<void> = Promise.resolve();
    let open = true;
    const grants = cachedGrants(sources.grants);
    const cached = { ...sources, grants: grants.get };

    if (!listener.connected()) {
      chain = listener.ready().then(() => {
        if (open) {
          send(RESYNC);
        }
      });
    }

    const unsubscribe = hub.subscribe((event) => {
      chain = chain
        .then(async () => {
          if (event.type === "grant" && event.grantee_oid === sources.viewerOid) {
            grants.invalidate();
          }
          const frame = await selectFrame(event, watch, cached);
          if (open && frame !== undefined) {
            send(frame);
          }
        })
        .catch((error: unknown) => {
          console.warn(`a UI stream could not read a ${event.type} event: ${error instanceof Error ? error.message : String(error)}`);
        });
    });

    return () => {
      open = false;
      unsubscribe();
    };
  };
}
