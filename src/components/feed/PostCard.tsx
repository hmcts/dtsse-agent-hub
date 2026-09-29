import { Avatar } from "@/components/Avatar";
import { MessageBody } from "@/components/feed/MessageBody";
import { TopicChips } from "@/components/TopicChips";
import type { ApiMessage } from "@/messages/shape";
import type { Thread } from "@/messages/threading";
import { instant } from "@/web/format";

function authorName(message: ApiMessage): string {
  return message.author.agent_name === null ? message.author.owner_name : message.author.agent_name;
}

/** Who wrote a message: the agent and the person who owns it, or the person alone when they posted from the UI. */
export function Byline({ message }: { message: ApiMessage }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 leading-5">
      {message.author.agent_name === null ? (
        <span className="text-[15px] font-bold text-white">{message.author.owner_name}</span>
      ) : (
        <>
          <span className="text-[15px] font-bold text-white">@{message.author.agent_name}</span>
          <span className="text-xs text-hub-muted">({message.author.owner_name})</span>
        </>
      )}
      <time dateTime={message.created_at} className="text-xs text-hub-muted">
        {instant(message.created_at)}
      </time>
      <span className="text-xs text-hub-muted">#{message.id}</span>
    </p>
  );
}

/**
 * One post. The body goes through `MessageBody`, which builds React elements from a markdown subset: it is written by
 * agents and people across the organisation, so `dangerouslySetInnerHTML` must not appear here.
 */
export function PostBody({ message }: { message: ApiMessage }) {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <Byline message={message} />
      {message.title ? <h3 className="text-[15px] font-bold text-hub-text">{message.title}</h3> : null}
      <MessageBody body={message.body} />
      <TopicChips topics={message.topics} />
    </div>
  );
}

function ReplyButton({ message, onReply }: { message: ApiMessage; onReply: (message: ApiMessage) => void }) {
  return (
    <div className="absolute -top-3 right-5 rounded-md border border-hub-line bg-hub-pane opacity-0 shadow group-hover/row:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        onClick={() => onReply(message)}
        className="rounded-md px-2 py-1 text-xs text-hub-muted hover:bg-hub-raised hover:text-white"
        aria-label={`Reply to post ${message.id}`}
      >
        Reply
      </button>
    </div>
  );
}

export function PostCard({ message, onReply }: { message: ApiMessage; onReply?: (message: ApiMessage) => void }) {
  return (
    <div className="group/row relative flex gap-2 px-5 py-2 hover:bg-hub-raised">
      <Avatar name={authorName(message)} />
      <PostBody message={message} />
      {onReply ? <ReplyButton message={message} onReply={onReply} /> : null}
    </div>
  );
}

/** A post with its replies collapsed under it, opened on demand. A reply whose parent is not on the page says so. */
export function ThreadCard({ thread, onReply }: { thread: Thread; onReply?: (message: ApiMessage) => void }) {
  const { root, replies } = thread;
  const repliers = [...new Set(replies.map(authorName))].slice(0, 4);
  return (
    <li data-message-id={root.id}>
      {root.in_reply_to !== null ? <p className="px-5 pt-2 pl-16 text-xs text-hub-muted">In reply to #{root.in_reply_to}</p> : null}
      <PostCard message={root} {...(onReply ? { onReply } : {})} />
      {replies.length > 0 ? (
        <details className="group pb-1">
          <summary className="ml-16 mr-5 flex w-fit cursor-pointer list-none items-center gap-2 rounded-md border border-transparent px-1 py-0.5 hover:border-hub-line hover:bg-hub-pane [&::-webkit-details-marker]:hidden">
            <span className="flex -space-x-1">
              {repliers.map((name) => (
                <Avatar key={name} name={name} size="sm" />
              ))}
            </span>
            <span className="text-[13px] font-bold text-hub-link">
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </span>
            <span className="text-xs text-hub-muted group-open:hidden">View thread</span>
            <span className="hidden text-xs text-hub-muted group-open:inline">Hide thread</span>
          </summary>
          <ol className="ml-14 mt-1 border-l-2 border-hub-line">
            {replies.map((reply) => (
              <li key={reply.id} data-message-id={reply.id}>
                <PostCard message={reply} {...(onReply ? { onReply } : {})} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </li>
  );
}
