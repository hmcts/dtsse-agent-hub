import Link from "next/link";
import type { SharedChatLink } from "@/assistant/shares";
import { requireViewer } from "@/viewer/current";
import { sharedChats } from "@/web/data";

export const dynamic = "force-dynamic";

/**
 * Both sides of the viewer's shared chats: their own that they have shared, and those shared with them. Nothing is
 * here that was not explicitly shared — there is no browsing anyone else's chats from this page or any other.
 */
function Chats({ label, chats, manage }: { label: string; chats: readonly SharedChatLink[]; manage: boolean }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[15px] font-semibold">{label}</h2>
      {chats.length === 0 ? (
        <p className="text-[13px] text-asst-muted">{manage ? "You have not shared any of your chats." : "Nobody has shared a chat with you."}</p>
      ) : (
        <ul aria-label={label} className="flex flex-col gap-1">
          {chats.map((chat) => (
            <li key={chat.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-asst-line px-3 py-2 text-sm">
              <Link href={`/assistant/shared/${chat.id}`} className="min-w-0 flex-1 truncate text-asst-accent underline hover:text-asst-accent-hover">
                {chat.title}
              </Link>
              <span className="shrink-0 text-xs text-asst-faint">{chat.productLabel}</span>
              <span className="shrink-0 text-xs text-asst-muted">{chat.withWhom}</span>
              {manage ? (
                <Link href={`/assistant/${chat.id}?share=1`} className="shrink-0 text-xs text-asst-accent underline hover:text-asst-accent-hover">
                  Change who can read it
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function SharedChatsPage() {
  const viewer = await requireViewer();
  const { given, received } = await sharedChats(viewer);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-7 px-5 pb-10 pt-7">
        <div className="flex flex-col gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight">Shared chats</h1>
          <p className="text-pretty text-[13px] text-asst-body">
            A shared chat can be read by the people its owner named, and by nobody else. A reader sees the messages and the document as they stood when they
            opened it; they cannot reply, change anything, or open the files that were sent.
          </p>
        </div>
        <Chats label="Chats you have shared" chats={given} manage />
        <Chats label="Chats shared with you" chats={received} manage={false} />
        <p className="text-[13px]">
          <Link href="/assistant" className="text-asst-accent underline hover:text-asst-accent-hover">
            Back to the HMCTS Assistant
          </Link>
        </p>
      </div>
    </div>
  );
}
