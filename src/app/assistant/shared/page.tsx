import Link from "next/link";
import type { SharedChatLink } from "@/assistant/shares";
import { requireViewer } from "@/viewer/current";
import { sharedChats } from "@/web/data";

export const dynamic = "force-dynamic";

/**
 * Both sides of the viewer's shared chats: their own that they have shared, and those shared with them. Nothing is
 * here that was not explicitly shared — there is no browsing anyone else's chats from this page or any other.
 */
function Chats({
  label,
  chats,
  manage,
  empty,
  change = "Change who can read it",
  dialog = "share"
}: {
  label: string;
  chats: readonly SharedChatLink[];
  manage: boolean;
  empty: string;
  change?: string;
  dialog?: "share" | "fork";
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[15px] font-semibold">{label}</h2>
      {chats.length === 0 ? (
        <p className="text-[13px] text-asst-muted">{empty}</p>
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
                <Link href={`/assistant/${chat.id}?${dialog}=1`} className="shrink-0 text-xs text-asst-accent underline hover:text-asst-accent-hover">
                  {change}
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
  const { given, received, offered, forkable } = await sharedChats(viewer);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-7 px-5 pb-10 pt-7">
        <div className="flex flex-col gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight">Shared chats</h1>
          <p className="text-pretty text-[13px] text-asst-body">
            A shared chat can be read by the people its owner named, and by nobody else. A reader sees the most recent part of the chat and its document as they
            stood when the page was opened; they cannot reply, change anything, or open the files that were sent. A chat offered to fork can also be copied by
            the people named into their own Assistant, to carry on there; the original stays its owner's.
          </p>
        </div>
        <Chats label="Chats you have shared" chats={given} manage empty="You have not shared any of your chats." />
        <Chats label="Chats shared with you" chats={received} manage={false} empty="Nobody has shared a chat with you." />
        <Chats
          label="Chats you have let people fork"
          chats={offered}
          manage
          empty="You have not offered any of your chats to be forked."
          change="Change who can fork it"
          dialog="fork"
        />
        <Chats label="Chats you can fork" chats={forkable} manage={false} empty="Nobody has offered you a chat to fork." />
        <p className="text-[13px]">
          <Link href="/assistant" className="text-asst-accent underline hover:text-asst-accent-hover">
            Back to the HMCTS Assistant
          </Link>
        </p>
      </div>
    </div>
  );
}
