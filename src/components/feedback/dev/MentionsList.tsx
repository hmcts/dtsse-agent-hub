"use client";

import Link from "next/link";
import { startTransition, useEffect, useRef, useState } from "react";
import { CommentBody } from "@/components/feedback/ThreadCard";
import { Timestamp } from "@/components/time/Timestamp";
import { describeElement } from "@/feedback/anchor-words";
import type { FeedbackMentionView } from "@/feedback/mention-store";
import { pageName } from "@/feedback/team-views";
import type { ActionResult } from "@/web/action";
import { PRIMARY } from "./look";

/**
 * The comments that named the viewer with `@`, newest first: who, on which project and page, what about, and the way
 * to read it in place and reply. The ones they had not seen are marked New for as long as the list is open, and are
 * marked seen once it is on screen in a visible tab, which takes them off the sidebar's count. Only the ones it
 * showed are marked, so a mention that arrives while the list is being read is shown, then marked, in its turn.
 */
export function MentionsList({
  mentions,
  markSeen
}: Readonly<{ mentions: readonly FeedbackMentionView[]; markSeen: (input: { commentIds: unknown }) => Promise<ActionResult> }>) {
  const action = useRef(markSeen);
  action.current = markSeen;
  const unseen = mentions.filter((mention) => !mention.seen).map((mention) => mention.commentId);
  // Every one that was new at some render of this visit: marking them seen re-renders the list as seen.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set(unseen));
  const key = unseen.join(" ");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `unseen` as a value, so a re-render with the same ones marks nothing again
  useEffect(() => {
    if (unseen.length === 0) {
      return;
    }
    setFresh((current) => (unseen.every((id) => current.has(id)) ? current : new Set([...current, ...unseen])));
    const mark = () => startTransition(() => void action.current({ commentIds: unseen }).catch(() => undefined));
    if (document.visibilityState === "visible") {
      mark();
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        document.removeEventListener("visibilitychange", onVisible);
        mark();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [key]);

  if (mentions.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-asst-line px-5 py-6 text-[13px] text-asst-muted">
        Nobody has mentioned you yet. When someone types @ and your name in a comment on a prototype, it appears here.
      </p>
    );
  }
  return (
    <ol aria-label="Mentions" className="flex flex-col gap-2">
      {mentions.map((mention) => (
        <li key={mention.commentId}>
          <article
            aria-label={`${mention.author.name} mentioned you`}
            className={`flex flex-col gap-1.5 rounded-xl border bg-asst-raised px-4 py-3 ${fresh.has(mention.commentId) ? "border-asst-accent-line" : "border-asst-line"}`}
          >
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-asst-faint">
              {fresh.has(mention.commentId) ? <span className="rounded-full bg-asst-accent px-1.5 py-px font-semibold text-asst-ink">New</span> : null}
              <span className="text-sm text-asst-body">
                <span className="font-semibold text-asst-text">{mention.author.name}</span> mentioned you in{" "}
                <span className="font-semibold text-asst-text">{mention.projectName}</span>
              </span>
              <Timestamp iso={mention.createdAt} />
            </p>
            <p className="text-xs text-asst-muted">
              On {pageName(mention)}, {describeElement(mention.anchor)}
              {mention.threadStatus === "resolved" ? " · resolved since" : ""}
            </p>
            <CommentBody body={mention.body} mentions={mention.named.map((person) => person.oid)} people={mention.named} />
            <div>
              <Link href={mention.href} className={`${PRIMARY} mt-1 inline-flex`}>
                Open and reply
              </Link>
            </div>
          </article>
        </li>
      ))}
    </ol>
  );
}
