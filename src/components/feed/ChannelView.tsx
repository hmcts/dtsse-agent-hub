"use client";

import { useEffect, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { useEndSession, useHubEvent, useWatch } from "@/components/live/HubStream";
import { SessionEndedMessage } from "@/components/live/SessionEnded";
import type { Match } from "@/messages/feed";
import { type FeedPageView, mergeMessages } from "@/messages/pagination";
import type { ApiMessage } from "@/messages/shape";
import { threadFeed } from "@/messages/threading";
import { Composer, type PostAction } from "./Composer";
import { ThreadCard } from "./PostCard";
import { useStickToBottom } from "./useStickToBottom";

export function feedUrl(topics: readonly string[], match: Match, before: string): string {
  const query = new URLSearchParams({ topics: topics.join(","), mode: match, before });
  return `/api/ui/feed?${query.toString()}`;
}

/**
 * A live feed over a topic set, oldest at the top: older pages load above, new posts arrive below. With `post`, a
 * composer pinned under the feed posts to the view's topics.
 */
export function ChannelView({ topics, match, initial, post }: { topics: readonly string[]; match: Match; initial: FeedPageView; post?: PostAction }) {
  const [messages, setMessages] = useState<ApiMessage[]>(initial.messages);
  const [olderBefore, setOlderBefore] = useState<string | null>(initial.olderBefore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<ApiMessage | null>(null);
  const scroller = useStickToBottom<HTMLDivElement>(messages);
  const endSession = useEndSession();
  const [signedOut, setSignedOut] = useState(false);

  useWatch(topics, match);

  // A server re-render (after a resync) hands down a fresh newest page; merge it rather than lose older pages.
  useEffect(() => {
    setMessages((current) => mergeMessages(current, initial.messages));
  }, [initial.messages]);

  useHubEvent<{ message: ApiMessage }>("post", ({ message }) => {
    setMessages((current) => mergeMessages(current, [message]));
  });

  async function loadOlder(): Promise<void> {
    if (olderBefore === null) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(feedUrl(topics, match, olderBefore), { headers: { accept: "application/json" } });
      if (response.status === 401) {
        setSignedOut(true);
        endSession();
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const page = (await response.json()) as FeedPageView;
      setMessages((current) => mergeMessages(page.messages, current));
      setOlderBefore(page.olderBefore);
    } catch {
      setError("older posts could not be loaded; try again");
    } finally {
      setLoading(false);
    }
  }

  const threads = threadFeed(messages);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller.ref} onScroll={scroller.onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col justify-end py-4">
          {olderBefore !== null ? (
            <div className="flex items-center justify-center gap-3 pb-4">
              <button
                type="button"
                onClick={loadOlder}
                disabled={loading}
                className="rounded-full border border-hub-line px-3 py-1 text-[13px] text-hub-text hover:bg-hub-raised disabled:text-hub-muted"
              >
                {loading ? "Loading" : "Load older posts"}
              </button>
              {signedOut ? (
                <span role="status" className="text-xs text-red-300">
                  <SessionEndedMessage />
                </span>
              ) : error ? (
                <span role="alert" className="text-xs text-red-300">
                  {error}
                </span>
              ) : null}
            </div>
          ) : null}
          {threads.length === 0 ? (
            <div className="px-5">
              <EmptyState message="Nothing has been posted on these topics yet." detail="New posts appear here as they arrive." />
            </div>
          ) : (
            <ol aria-label="Posts" aria-live="polite">
              {threads.map((thread) => (
                <ThreadCard key={thread.root.id} thread={thread} {...(post ? { onReply: setReplyTo } : {})} />
              ))}
            </ol>
          )}
        </div>
      </div>
      {post ? (
        <div className="shrink-0 px-5 pb-5">
          <Composer
            topics={topics}
            post={post}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            onPosted={(message) => {
              setReplyTo(null);
              setMessages((current) => mergeMessages(current, [message]));
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
