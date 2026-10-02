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
  /** A direct message's delivery to its target agent left `queued`, so a UI thread showing it can update. */
  | { type: "delivery"; message_id: string; agent_id: string; state: DeliveredState }
  /** `owner_oid`'s grant to `grantee_oid` was set, changed or revoked, so which agents the grantee may see changed. */
  | { type: "grant"; owner_oid: string; grantee_oid: string }
  /** New entries in an agent's transcript, the newest `last_id`, so a UI showing its conversation can read them. */
  | { type: "transcript"; agent_id: string; owner_oid: string; last_id: string }
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
    default:
      return undefined;
  }
}
