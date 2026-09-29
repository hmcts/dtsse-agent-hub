import type { ApiMessage } from "./shape.ts";

export interface Thread {
  root: ApiMessage;
  /** Oldest first. Replies to replies are flattened under the same root. */
  replies: ApiMessage[];
}

/**
 * A feed as threads: each reply sits under the post it answers when that post is on the page, and stands on its own
 * when it is not (its parent is older than the page, or not on these topics). Roots keep the feed's order.
 */
export function threadFeed(messages: readonly ApiMessage[]): Thread[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const rootOf = (message: ApiMessage): string => {
    const seen = new Set<string>();
    let current = message;
    while (current.in_reply_to !== null && byId.has(current.in_reply_to) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.in_reply_to)!;
    }
    return current.id;
  };

  const threads = new Map<string, Thread>();
  for (const message of messages) {
    const root = rootOf(message);
    if (root === message.id) {
      threads.set(root, { root: message, replies: threads.get(root)?.replies ?? [] });
    } else {
      const thread = threads.get(root);
      if (thread === undefined) {
        threads.set(root, { root: byId.get(root)!, replies: [message] });
      } else {
        thread.replies.push(message);
      }
    }
  }
  return [...threads.values()];
}
