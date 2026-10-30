import { Avatar } from "@/components/Avatar";
import { MessageBody } from "@/components/feed/MessageBody";
import { BYLINE_ID, MessageLink } from "@/components/feed/MessageLink";
import { Timestamp } from "@/components/time/Timestamp";
import type { DeliveryView, ThreadMessage } from "@/messages/direct-thread";

const DELIVERY_STYLE: Record<DeliveryView, string> = {
  queued: "border-amber-700 text-amber-300",
  delivered: "border-green-800 text-green-300",
  expired: "border-hub-line text-hub-muted"
};

export function senderName(message: ThreadMessage): string {
  return message.author.agent_name === null ? message.author.owner_name : `@${message.author.agent_name}`;
}

function DeliveryBadge({ state }: { state: DeliveryView }) {
  return <span className={`rounded-sm border px-1 text-[11px] uppercase tracking-wide ${DELIVERY_STYLE[state]}`}>{state}</span>;
}

/**
 * One direct message in an agent's conversation, with which way it went and its delivery to the target.
 *
 * `repoBase` is this agent's repo, so it is handed to the body only for a message this agent wrote: a message from
 * somebody else's session cites paths in whatever repo that one is working in, which is not this one.
 */
export function DirectMessage({ agentId, message, repoBase = null }: { agentId: string; message: ThreadMessage; repoBase?: string | null }) {
  const fromAgent = message.author.agent_id === agentId;
  const name = senderName(message);
  return (
    <li className="flex gap-2 px-5 py-2 hover:bg-hub-raised" data-message-id={message.id}>
      <Avatar name={name} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 leading-5">
          <span className="text-[15px] font-bold text-white">{name}</span>
          {message.author.agent_name === null ? null : <span className="text-xs text-hub-muted">({message.author.owner_name})</span>}
          <span className="text-xs text-hub-muted">{fromAgent ? (message.target_agent_id === null ? "replied" : "sent") : "to this agent"}</span>
          <Timestamp iso={message.created_at} className="text-xs text-hub-muted" />
          <MessageLink id={message.id} className={BYLINE_ID} />
          {message.delivery !== null ? <DeliveryBadge state={message.delivery} /> : null}
        </p>
        <MessageBody body={message.body} repoBase={fromAgent ? repoBase : null} />
      </div>
    </li>
  );
}
