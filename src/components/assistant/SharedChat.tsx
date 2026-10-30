import Link from "next/link";
import type { SharedConversationView } from "@/assistant/sharing";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { ForkButton, type ForkChatAction } from "@/components/assistant/ForkButton";
import { ForkedThread } from "@/components/assistant/ForkedThread";
import { SharedItem } from "@/components/assistant/SharedItem";

/**
 * A chat someone shared, to read.
 *
 * A server component with nothing interactive in it, which is what read-only means here: there is no composer, no
 * menu, no document editor and no stream, so there is nothing on the page that could ask the hub to change the chat
 * even if a rule above it were wrong. It is also a snapshot — the thread as it stood when the page was read.
 *
 * The one control is the fork's, for someone the owner offered the chat to, and it writes nothing here either: it
 * makes the viewer their own copy in their own CFT Workspace.
 */

function headline(view: SharedConversationView): string {
  if (view.access === "owner") {
    return "Your chat, as the people you shared it with see it";
  }
  return view.fork === null
    ? `Shared with you by ${view.ownerName}. You can read it only.`
    : `Shared with you by ${view.ownerName}, to continue in your own CFT Workspace if you want to.`;
}

export function SharedChat({ view, forkChat }: { view: SharedConversationView; forkChat?: ForkChatAction }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-asst-field px-4">
        <h1 className="min-w-[4rem] shrink-[999] truncate text-[15px] font-medium">{view.title}</h1>
        <span className="shrink-0 rounded-md border border-asst-accent-line px-2 py-1 font-plex-mono text-[11px] uppercase leading-none tracking-wider text-asst-accent-soft">
          {view.productLabel}
        </span>
        <span className="ml-auto shrink-0 text-xs text-asst-faint">{headline(view)}</span>
        {view.fork === null || forkChat === undefined ? null : <ForkButton conversationId={view.id} copyId={view.fork.copyId} forkChat={forkChat} />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[900px] flex-col gap-[26px] px-5 pb-10 pt-7">
          {view.forked === null || view.earlierHidden ? null : <ForkedThread forked={view.forked} />}
          {view.earlierHidden ? (
            <p className="text-center text-[13px] text-asst-muted">This is the most recent part of the chat. What came before it is not shown here.</p>
          ) : null}
          {view.thread.length === 0 ? (
            <p className="text-center text-[13px] text-asst-muted">Nothing has been said in this chat yet.</p>
          ) : (
            <ol aria-label="Conversation" className="flex flex-col gap-[26px]">
              {view.thread.map((item) => (
                <SharedItem key={item.key} item={item} />
              ))}
            </ol>
          )}
          {view.document === null ? null : (
            <section aria-labelledby="shared-document" className="flex flex-col gap-3 rounded-2xl border border-asst-line p-5">
              <h2 id="shared-document" className="text-[18px] font-semibold">
                {view.document.title}
              </h2>
              <AssistantMarkdown source={view.document.markdown} document />
            </section>
          )}
          <p className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-asst-faint">
            <Link href="/assistant/shared" className="text-asst-accent underline hover:text-asst-accent-hover">
              {view.access === "owner" ? "See all your shared chats" : "See other chats shared with you"}
            </Link>
            <Link href="/assistant" className="text-asst-accent underline hover:text-asst-accent-hover">
              Open the CFT Workspace
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
