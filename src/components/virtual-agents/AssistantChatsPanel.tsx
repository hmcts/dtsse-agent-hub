import type { ConversationLink } from "@/assistant/views";
import { Section } from "@/components/Section";

/** The HMCTS Assistant chats this virtual agent runs, each a session of its own beside the main one. Owner only. */
export function AssistantChatsPanel({ chats }: { chats: readonly ConversationLink[] }) {
  return (
    <Section heading="HMCTS Assistant chats" detail={chats.length === 0 ? "none yet" : `${chats.length}`}>
      {chats.length === 0 ? (
        <p className="text-[13px] text-hub-muted">
          Chats in the{" "}
          <a href="/assistant" className="text-hub-link underline hover:no-underline">
            HMCTS Assistant
          </a>{" "}
          run on this virtual agent, each in a Claude session of its own.
        </p>
      ) : (
        <ul aria-label="HMCTS Assistant chats" className="space-y-1">
          {chats.map((chat) => (
            // The title is what tells one chat from another, so the product label is what gives way: labels run to
            // 40 characters, and the label keeps at most two fifths of the row.
            <li key={chat.id} className="flex min-w-0 items-baseline gap-2 text-[13px]">
              <a href={`/assistant/${chat.id}`} className="min-w-0 flex-1 truncate text-hub-link underline hover:no-underline">
                {chat.title}
              </a>
              <span className="min-w-0 max-w-[40%] truncate text-xs text-hub-muted">{chat.productLabel}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
