import { HttpError } from "../agent-api/http.ts";
import { notify } from "../realtime/notify.ts";
import type { Database } from "../store/prisma.ts";
import { storedProduct } from "./products.ts";

export class ConversationNotFound extends HttpError {
  constructor() {
    super(404, "no such conversation");
  }
}

export interface ConversationRow {
  id: string;
  ownerOid: string;
  /** The virtual agent whose pod runs its sessions, or null for a conversation that is a local session. */
  virtualAgentId: string | null;
  agentId: string | null;
  title: string | null;
  product: string;
  productHistory: ProductChange[];
  stopHistory: StopMark[];
  wakeRequestedAt: Date | null;
  sessionState: SessionState | null;
  sessionDetail: string | null;
  lastActiveAt: Date;
  createdAt: Date;
}

export type SessionState = "starting" | "live" | "queued";

export interface ProductChange {
  product: string;
  at: string;
}

/** When the person stopped an answer, which is where the thread shows that they did. */
export interface StopMark {
  at: string;
}

export const SELECT = {
  id: true,
  ownerOid: true,
  virtualAgentId: true,
  agentId: true,
  title: true,
  product: true,
  productHistory: true,
  stopHistory: true,
  wakeRequestedAt: true,
  sessionState: true,
  sessionDetail: true,
  lastActiveAt: true,
  createdAt: true
} as const;

/** The stored product history, as the thread reads it. */
export function storedHistory(value: unknown): ProductChange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (change): change is ProductChange => typeof change === "object" && change !== null && typeof change.product === "string" && typeof change.at === "string"
  );
}

/** The stored stop history, as the thread reads it. */
export function storedStops(value: unknown): StopMark[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((mark): mark is StopMark => typeof mark === "object" && mark !== null && typeof mark.at === "string");
}

export function toRow(row: {
  id: string;
  ownerOid: string;
  virtualAgentId: string | null;
  agentId: string | null;
  title: string | null;
  product: string;
  productHistory: unknown;
  stopHistory: unknown;
  wakeRequestedAt: Date | null;
  sessionState: string | null;
  sessionDetail: string | null;
  lastActiveAt: Date;
  createdAt: Date;
}): ConversationRow {
  const state = row.sessionState;
  return {
    ...row,
    // A row reads as a product the list offers, so every page agrees with the picker. What a session is told does
    // not go through here: `assistantFrame` and `pendingWakes` carry the slug as stored.
    product: storedProduct(row.product),
    productHistory: storedHistory(row.productHistory),
    stopHistory: storedStops(row.stopHistory),
    sessionState: state === "starting" || state === "live" || state === "queued" ? state : null
  };
}

/**
 * Tells the owner's open tabs, and the pod's sessions stream, that the conversation changed; called inside the
 * transaction that changed it.
 *
 * Sent for a conversation with no pod as well, carrying a null `virtual_agent_id`. The owner's tabs are the
 * subscriber that matters here and `ui-stream` selects this frame on `owner_oid`, so having no pod means there is
 * nobody to *instruct*, not nobody to tell: a local chat renamed or deleted has to redraw like any other. A null
 * `virtual_agent_id` matches no pod's sessions stream.
 */
export async function announce(db: Database, conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">): Promise<void> {
  await notify(db, {
    type: "assistant_conversation",
    conversation_id: conversation.id,
    virtual_agent_id: conversation.virtualAgentId,
    owner_oid: conversation.ownerOid
  });
}
