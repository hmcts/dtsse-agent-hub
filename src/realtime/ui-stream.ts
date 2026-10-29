import { type AgentRef, canReadMessage, canSeeAgentSkills, canViewAgent, canViewTranscript, canViewVirtualAgent } from "../access/rules.ts";
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
 * - `agent_skills`: the watched agent reported a changed list of skills, when the viewer may see them. Only the id is
 *   sent; the page re-reads, which hands its composer the new list.
 * - `agent_question`: the watched agent asked a question, or one of its questions was answered, when the viewer can
 *   still see that agent. Only the id is sent; the page re-reads, which hands the thread the cards.
 * - `virtual_agent`: one of the viewer's own virtual agents changed, so the live view keeps up with the page rather
 *   than quietly going stale. Only the id is sent, which is no more than the page already shows them: its login codes
 *   and settings are read under their own rule when the page re-reads.
 * - `assistant_conversation`: one of the viewer's own assistant conversations changed. Only the id is sent, and only
 *   to its owner; the page re-reads it.
 * - `resync`: the pod's listener reconnected and NOTIFYs may have been missed, or the viewer saved or deleted a
 *   credential, perhaps from the CLI; either way the page should re-read. Also sent once `LISTEN` becomes active
 *   when the stream opened before it was, since anything committed until then was never notified.
 *
 * A post is read once per pod and shared by every stream, since anyone may read it. Nothing else is cached or
 * re-read: every rule below is answered from the event's own `owner_oid` or from the agent the stream opened on, and
 * what either says cannot change while a connection is open — an agent does not change hands. Work is chained so
 * frames leave in the order the hub published them.
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
      if (!canViewAgent(sources.viewerOid, { id: event.agent_id, ownerOid: event.owner_oid })) {
        return undefined;
      }
      return sseEvent({ event: "agent_status", data: JSON.stringify({ agent_id: event.agent_id, status: event.status }) });
    }
    case "direct": {
      const agent = watch.agent;
      if (agent === null || (event.target_agent_id !== agent.id && event.author_agent_id !== agent.id)) {
        return undefined;
      }
      if (!canViewAgent(sources.viewerOid, agent)) {
        return undefined;
      }
      const loaded = await sources.direct(BigInt(event.message_id));
      if (loaded === undefined || !canReadMessage(sources.viewerOid, loaded.ref)) {
        return undefined;
      }
      return sseEvent({ id: loaded.message.id, event: "direct", data: JSON.stringify({ message: loaded.message }) });
    }
    case "delivery": {
      const agent = watch.agent;
      if (agent === null || event.agent_id !== agent.id || !canViewAgent(sources.viewerOid, agent)) {
        return undefined;
      }
      return sseEvent({ event: "delivery", data: JSON.stringify({ message_id: event.message_id, state: event.state }) });
    }
    case "transcript": {
      const agent = watch.agent;
      if (agent === null || event.agent_id !== agent.id || !canViewTranscript(sources.viewerOid, agent)) {
        return undefined;
      }
      return sseEvent({ event: "transcript", data: JSON.stringify({ agent_id: event.agent_id, last_id: event.last_id }) });
    }
    case "agent_skills": {
      const agent = watch.agent;
      if (agent === null || event.agent_id !== agent.id || !canSeeAgentSkills(sources.viewerOid, agent)) {
        return undefined;
      }
      return sseEvent({ event: "agent_skills", data: JSON.stringify({ agent_id: event.agent_id }) });
    }
    case "agent_question": {
      const agent = watch.agent;
      if (agent === null || event.agent_id !== agent.id || !canViewAgent(sources.viewerOid, agent)) {
        return undefined;
      }
      return sseEvent({ event: "agent_question", data: JSON.stringify({ agent_id: event.agent_id }) });
    }
    // Never sent to a browser: it is how one agent's stream recognises a post of its own. The post itself arrives as
    // the `post` event beside it, which is what puts it in front of everyone watching its topics, tags and all.
    case "tagged_post":
      return undefined;
    case "credential":
      return event.owner_oid === sources.viewerOid ? RESYNC : undefined;
    case "virtual_agent":
      return canViewVirtualAgent(sources.viewerOid, { id: event.virtual_agent_id, ownerOid: event.owner_oid })
        ? sseEvent({ event: "virtual_agent", data: JSON.stringify({ virtual_agent_id: event.virtual_agent_id }) })
        : undefined;
    case "assistant_conversation":
      return event.owner_oid === sources.viewerOid
        ? sseEvent({ event: "assistant_conversation", data: JSON.stringify({ conversation_id: event.conversation_id }) })
        : undefined;
    // Never sent to a browser: it is an instruction to the conversation's pod. The stop is recorded on the
    // conversation in the same transaction, and the `assistant_conversation` beside it is what redraws the thread.
    case "assistant_stop":
      return undefined;
    // Also an instruction to the pod. The settings dialog is rendered by the page, and both the request and the
    // pod's report revalidate `/assistant`, so there is nothing for an open stream to tell a browser about.
    case "assistant_uploads":
      return undefined;
    // A lookup is asked and answered between the hub and the pod; the browser that asked is waiting on its own
    // request for the answer, so no stream needs to carry either.
    case "assistant_lookup":
    case "assistant_lookup_answered":
      return undefined;
    // The same for a Welsh job: the Welsh page reads its own job back.
    case "assistant_welsh":
    case "assistant_welsh_answered":
      return undefined;
    case "resync":
      return RESYNC;
  }
}

export function uiStream(watch: UiWatch, { hub, listener, ...sources }: UiStreamSources): OnOpen {
  return (send: Send) => {
    let chain: Promise<void> = Promise.resolve();
    let open = true;

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
          const frame = await selectFrame(event, watch, sources);
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
