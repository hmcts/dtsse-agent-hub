import type { NotifiedEvent } from "../events.ts";

/**
 * One sample of every event that crosses pods, as a record keyed by type so that it has to be total. A new member of
 * `NotifiedEvent` has no entry here until someone adds one, which is a compile error, and the tests that read this
 * are then what prove `decodeEvent` has an arm for it and that the browser subscribes to its frame. A hand-written
 * list would have let the new member go unnoticed in both places, which is the drift this guards.
 *
 * Several samples per type where the shape has variants worth decoding separately.
 */
export const NOTIFIED_EVENT_SAMPLES: { [T in NotifiedEvent["type"]]: readonly Extract<NotifiedEvent, { type: T }>[] } = {
  post: [{ type: "post", message_id: "12" }],
  direct: [
    { type: "direct", message_id: "13", target_agent_id: "agent-b", author_agent_id: "agent-a" },
    { type: "direct", message_id: "14", target_agent_id: null, author_agent_id: "agent-a" },
    { type: "direct", message_id: "15", target_agent_id: "agent-b", author_agent_id: null }
  ],
  tagged_post: [{ type: "tagged_post", message_id: "12", agent_id: "agent-b" }],
  agent_status: [{ type: "agent_status", agent_id: "agent-a", owner_oid: "oid-a", status: "offline" }],
  agent_skills: [{ type: "agent_skills", agent_id: "agent-a", owner_oid: "oid-a" }],
  agent_question: [{ type: "agent_question", agent_id: "agent-a", owner_oid: "oid-a" }],
  delivery: [{ type: "delivery", message_id: "16", agent_id: "agent-b", state: "delivered" }],
  transcript: [{ type: "transcript", agent_id: "agent-a", owner_oid: "oid-a", last_id: "17" }],
  credential: [{ type: "credential", owner_oid: "oid-a", kind: "github" }],
  virtual_agent: [{ type: "virtual_agent", virtual_agent_id: "va-a", owner_oid: "oid-a" }],
  assistant_conversation: [
    { type: "assistant_conversation", conversation_id: "c-a", virtual_agent_id: "va-a", owner_oid: "oid-a" },
    // A conversation that is a person's own local session: no pod, and the owner's tabs are the subscriber.
    { type: "assistant_conversation", conversation_id: "c-b", virtual_agent_id: null, owner_oid: "oid-a" }
  ],
  assistant_stop: [{ type: "assistant_stop", conversation_id: "c-a", virtual_agent_id: "va-a", owner_oid: "oid-a" }],
  assistant_uploads: [{ type: "assistant_uploads", virtual_agent_id: "va-a", owner_oid: "oid-a" }],
  assistant_lookup: [{ type: "assistant_lookup", lookup_id: "l-a", virtual_agent_id: "va-a", owner_oid: "oid-a" }],
  assistant_lookup_answered: [{ type: "assistant_lookup_answered", lookup_id: "l-a", virtual_agent_id: "va-a", owner_oid: "oid-a" }]
};

/** Every type that crosses pods, in the order the samples are written. */
export const NOTIFIED_EVENT_TYPES = Object.keys(NOTIFIED_EVENT_SAMPLES) as NotifiedEvent["type"][];

/** Every sample, flattened, for a test that wants to run over all of them. */
export const NOTIFIED_EVENTS: NotifiedEvent[] = Object.values(NOTIFIED_EVENT_SAMPLES).flat();
