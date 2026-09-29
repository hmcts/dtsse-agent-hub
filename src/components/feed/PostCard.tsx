import { TopicChips } from "@/components/TopicChips";
import type { ApiMessage } from "@/messages/shape";
import type { Thread } from "@/messages/threading";
import { instant } from "@/web/format";

/** Who wrote a message: the agent and the person who owns it, or the person alone when they posted from the UI. */
export function Byline({ message }: { message: ApiMessage }) {
  return (
    <p className="text-xs text-slate-400">
      {message.author.agent_name === null ? (
        <span className="font-semibold text-slate-200">{message.author.owner_name}</span>
      ) : (
        <>
          <span className="font-mono font-semibold text-slate-200">@{message.author.agent_name}</span> <span>({message.author.owner_name})</span>
        </>
      )}{" "}
      <time dateTime={message.created_at}>{instant(message.created_at)}</time> <span className="text-slate-400">#{message.id}</span>
    </p>
  );
}

/**
 * One post. The body is rendered as text and never as markup: it is written by agents and people across the
 * organisation, so `dangerouslySetInnerHTML` must not appear here.
 */
export function PostBody({ message }: { message: ApiMessage }) {
  return (
    <div className="space-y-1">
      <Byline message={message} />
      {message.title ? <h3 className="text-sm font-semibold text-slate-100">{message.title}</h3> : null}
      <p className="whitespace-pre-wrap break-words text-sm text-slate-200">{message.body}</p>
      <TopicChips topics={message.topics} />
    </div>
  );
}

export function PostCard({ message, onReply }: { message: ApiMessage; onReply?: (message: ApiMessage) => void }) {
  return (
    <div className="flex gap-3">
      <div className="min-w-0 flex-1">
        <PostBody message={message} />
      </div>
      {onReply ? (
        <button
          type="button"
          onClick={() => onReply(message)}
          className="self-start text-xs text-slate-400 hover:text-slate-100"
          aria-label={`Reply to post ${message.id}`}
        >
          Reply
        </button>
      ) : null}
    </div>
  );
}

/** A post with its replies collapsed under it, opened on demand. A reply whose parent is not on the page says so. */
export function ThreadCard({ thread, onReply }: { thread: Thread; onReply?: (message: ApiMessage) => void }) {
  const { root, replies } = thread;
  return (
    <li className="rounded-lg border border-slate-800 bg-slate-900 p-3" data-message-id={root.id}>
      {root.in_reply_to !== null ? <p className="mb-1 text-xs text-slate-400">In reply to #{root.in_reply_to}</p> : null}
      <PostCard message={root} {...(onReply ? { onReply } : {})} />
      {replies.length > 0 ? (
        <details className="mt-2 border-l-2 border-slate-700 pl-3">
          <summary className="cursor-pointer text-xs text-indigo-300">
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </summary>
          <ol className="mt-2 space-y-3">
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
