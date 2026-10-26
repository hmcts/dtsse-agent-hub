/**
 * What crosses between pods on the `hub_events` channel, and between the listener and every open stream in a pod.
 *
 * Payloads carry ids only: a NOTIFY payload is capped at 8000 bytes, and a subscriber that needs the message reads
 * it with its own access check rather than trusting what arrived on the wire.
 */

export const HUB_CHANNEL = "hub_events";

export type AgentStatus = "busy" | "idle" | "offline";

export type DeliveredState = "delivered" | "expired";

export type HubEvent =
  | { type: "post"; message_id: string }
  | { type: "direct"; message_id: string; target_agent_id: string | null; author_agent_id: string | null }
  | { type: "agent_status"; agent_id: string; owner_oid: string; status: AgentStatus }
  /** The skills `owner_oid`'s agent reported changed. Never carries the list, which only some viewers may see. */
  | { type: "agent_skills"; agent_id: string; owner_oid: string }
  /** A direct message's delivery to its target agent left `queued`, so a UI thread showing it can update. */
  | { type: "delivery"; message_id: string; agent_id: string; state: DeliveredState }
  /** `owner_oid`'s grant to `grantee_oid` was set, changed or revoked, so which agents the grantee may see changed. */
  | { type: "grant"; owner_oid: string; grantee_oid: string }
  /** New entries in an agent's transcript, the newest `last_id`, so a UI showing its conversation can read them. */
  | { type: "transcript"; agent_id: string; owner_oid: string; last_id: string }
  /** `owner_oid`'s stored credential of `kind` was saved or deleted. Never carries the value. */
  | { type: "credential"; owner_oid: string; kind: string }
  /** `owner_oid`'s virtual agent changed: what they asked for, its status, its logins or its linked agent. */
  | { type: "virtual_agent"; virtual_agent_id: string; owner_oid: string }
  /**
   * `owner_oid`'s assistant conversation changed: created, renamed, deleted, its product, its artefact, its session or
   * a wake. `virtual_agent_id` is the assistant's, so its pod's sessions stream hears of wakes and deletions.
   */
  | { type: "assistant_conversation"; conversation_id: string; virtual_agent_id: string; owner_oid: string }
  /**
   * The person stopped the answer their conversation was working on, so its pod should interrupt the session.
   *
   * Its own type rather than an `assistant_conversation`, because it is the one assistant event that is an instruction
   * and not a change to re-read: a subscriber acts on it once, where every `assistant_conversation` re-reads the row
   * and would therefore need the stop persisted as pending and cleared again. A NOTIFY lost while the listener was
   * down is the right thing to lose — the turn it would have ended is long over, and a stop that fired on the
   * `resync` replay would interrupt whatever the session had moved on to.
   */
  | { type: "assistant_stop"; conversation_id: string; virtual_agent_id: string; owner_oid: string }
  /**
   * The owner asked for files on `virtual_agent_id`'s own volume to be deleted, so its pod should go and delete them.
   *
   * Carries the assistant rather than a conversation, because one request can cover every conversation at once and
   * the stream re-reads the outstanding ones anyway. That it re-reads is the difference from `assistant_stop`: the
   * request is a row, so a NOTIFY lost while the listener was down costs nothing and the `resync` replay is wanted.
   */
  | { type: "assistant_uploads"; virtual_agent_id: string; owner_oid: string }
  /**
   * The owner searched their Jira or Confluence, so `virtual_agent_id`'s pod should run the lookup and answer it. An
   * instruction like `assistant_stop`, sent once: a search lost while the listener was down is one nobody is still
   * typing for, so a `resync` does not replay it.
   */
  | { type: "assistant_lookup"; lookup_id: string; virtual_agent_id: string; owner_oid: string }
  /** The pod answered the lookup, so the request waiting for it can read the answer. */
  | { type: "assistant_lookup_answered"; lookup_id: string; virtual_agent_id: string; owner_oid: string }
  /**
   * Published in-process only, when the listener reconnects. NOTIFYs sent while it was disconnected are lost, so
   * every stream re-reads its queued deliveries.
   */
  | { type: "resync" };

export type NotifiedEvent = Exclude<HubEvent, { type: "resync" }>;

export function encodeEvent(event: NotifiedEvent): string {
  return JSON.stringify(event);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isOptionalId(value: unknown): value is string | null {
  return value === null || isId(value);
}

const STATUSES: readonly string[] = ["busy", "idle", "offline"];
const DELIVERED_STATES: readonly string[] = ["delivered", "expired"];

/** The event a NOTIFY payload carries, or `undefined` for anything this version does not understand. */
export function decodeEvent(payload: string | undefined): NotifiedEvent | undefined {
  if (payload === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "post":
      return isId(event.message_id) ? { type: "post", message_id: event.message_id } : undefined;
    case "direct":
      return isId(event.message_id) && isOptionalId(event.target_agent_id) && isOptionalId(event.author_agent_id)
        ? { type: "direct", message_id: event.message_id, target_agent_id: event.target_agent_id, author_agent_id: event.author_agent_id }
        : undefined;
    case "agent_status":
      return isId(event.agent_id) && isId(event.owner_oid) && typeof event.status === "string" && STATUSES.includes(event.status)
        ? { type: "agent_status", agent_id: event.agent_id, owner_oid: event.owner_oid, status: event.status as AgentStatus }
        : undefined;
    case "agent_skills":
      return isId(event.agent_id) && isId(event.owner_oid) ? { type: "agent_skills", agent_id: event.agent_id, owner_oid: event.owner_oid } : undefined;
    case "delivery":
      return isId(event.message_id) && isId(event.agent_id) && typeof event.state === "string" && DELIVERED_STATES.includes(event.state)
        ? { type: "delivery", message_id: event.message_id, agent_id: event.agent_id, state: event.state as DeliveredState }
        : undefined;
    case "grant":
      return isId(event.owner_oid) && isId(event.grantee_oid) ? { type: "grant", owner_oid: event.owner_oid, grantee_oid: event.grantee_oid } : undefined;
    case "transcript":
      return isId(event.agent_id) && isId(event.owner_oid) && isId(event.last_id)
        ? { type: "transcript", agent_id: event.agent_id, owner_oid: event.owner_oid, last_id: event.last_id }
        : undefined;
    case "credential":
      return isId(event.owner_oid) && isId(event.kind) ? { type: "credential", owner_oid: event.owner_oid, kind: event.kind } : undefined;
    case "virtual_agent":
      return isId(event.virtual_agent_id) && isId(event.owner_oid)
        ? { type: "virtual_agent", virtual_agent_id: event.virtual_agent_id, owner_oid: event.owner_oid }
        : undefined;
    case "assistant_conversation":
      return isId(event.conversation_id) && isId(event.virtual_agent_id) && isId(event.owner_oid)
        ? { type: "assistant_conversation", conversation_id: event.conversation_id, virtual_agent_id: event.virtual_agent_id, owner_oid: event.owner_oid }
        : undefined;
    case "assistant_stop":
      return isId(event.conversation_id) && isId(event.virtual_agent_id) && isId(event.owner_oid)
        ? { type: "assistant_stop", conversation_id: event.conversation_id, virtual_agent_id: event.virtual_agent_id, owner_oid: event.owner_oid }
        : undefined;
    case "assistant_uploads":
      return isId(event.virtual_agent_id) && isId(event.owner_oid)
        ? { type: "assistant_uploads", virtual_agent_id: event.virtual_agent_id, owner_oid: event.owner_oid }
        : undefined;
    case "assistant_lookup":
    case "assistant_lookup_answered":
      return isId(event.lookup_id) && isId(event.virtual_agent_id) && isId(event.owner_oid)
        ? { type: event.type, lookup_id: event.lookup_id, virtual_agent_id: event.virtual_agent_id, owner_oid: event.owner_oid }
        : undefined;
    default:
      return undefined;
  }
}
