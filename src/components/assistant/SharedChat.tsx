import Link from "next/link";
import type { SharedConversationView, SharedThreadItem } from "@/assistant/sharing";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { Mark } from "@/components/assistant/AssistantShell";

/**
 * A chat someone shared, to read.
 *
 * A server component with nothing interactive in it, which is what read-only means here: there is no composer, no
 * menu, no document editor and no stream, so there is nothing on the page that could ask the hub to change the chat
 * even if a rule above it were wrong. It is also a snapshot — the thread as it stood when the page was read.
 */

function files(count: number): string {
  return count === 1 ? "1 file sent with this message" : `${count} files sent with this message`;
}

function Item({ item }: { item: SharedThreadItem }) {
  if (item.type === "product") {
    return (
      <li className="flex items-center gap-3 text-xs text-asst-faint">
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
        Product changed to {item.label}
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
      </li>
    );
  }
  // Said of the owner rather than of the reader, who stopped nothing: without it an answer simply ends mid-thought.
  if (item.type === "stopped") {
    return (
      <li className="flex items-center gap-3 text-xs text-asst-faint">
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
        This answer was stopped
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
      </li>
    );
  }
  if (item.type === "user") {
    return (
      <li className="flex flex-col items-end gap-1">
        <span className="sr-only">They asked:</span>
        {item.text === "" ? null : (
          <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-[18px_18px_4px_18px] bg-asst-bubble px-4 py-2.5">{item.text}</div>
        )}
        {/* The names and sizes are the owner's; a share says only that files went with the message. */}
        {item.attachmentCount === 0 ? null : <span className="text-xs text-asst-faint">{files(item.attachmentCount)}</span>}
      </li>
    );
  }
  return (
    <li className="flex items-start gap-3.5">
      <span className="mt-px">
        <Mark size="sm" />
      </span>
      <div className="min-w-0 flex-1 text-asst-body">
        <span className="sr-only">The assistant said:</span>
        <AssistantMarkdown source={item.text} />
      </div>
    </li>
  );
}

export function SharedChat({ view }: { view: SharedConversationView }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-asst-field px-4">
        <h1 className="min-w-[4rem] shrink-[999] truncate text-[15px] font-medium">{view.title}</h1>
        <span className="shrink-0 rounded-md border border-asst-accent-line px-2 py-1 font-plex-mono text-[11px] uppercase leading-none tracking-wider text-asst-accent-soft">
          {view.productLabel}
        </span>
        <span className="ml-auto shrink-0 text-xs text-asst-faint">
          {view.access === "owner" ? "Your chat, as the people you shared it with see it" : `Shared with you by ${view.ownerName}. You can read it only.`}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[900px] flex-col gap-[26px] px-5 pb-10 pt-7">
          {view.earlierHidden ? (
            <p className="text-center text-[13px] text-asst-muted">This is the most recent part of the chat. What came before it is not shown here.</p>
          ) : null}
          {view.thread.length === 0 ? (
            <p className="text-center text-[13px] text-asst-muted">Nothing has been said in this chat yet.</p>
          ) : (
            <ol aria-label="Conversation" className="flex flex-col gap-[26px]">
              {view.thread.map((item) => (
                <Item key={item.key} item={item} />
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
          <p className="text-center text-xs text-asst-faint">
            <Link href="/assistant" className="text-asst-accent underline hover:text-asst-accent-hover">
              Open the HMCTS Assistant
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
