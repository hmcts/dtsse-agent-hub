import Link from "next/link";
import { SHARED_CHATS } from "@/web/home";

/**
 * A shared chat the viewer may not read, or one that does not exist: the page cannot tell them which, since saying a
 * chat exists would be telling someone it was never shared with. What it can say is the thing the person almost
 * always needs to hear, that a link opens a chat only for the people it is shared with, and who can fix that.
 */
export default function SharedChatNotFound() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-10">
      <div className="flex max-w-[480px] flex-col gap-3 text-pretty">
        <h1 className="text-lg font-semibold">This chat has not been shared with you</h1>
        <p className="text-[15px] text-asst-body">
          A link to a shared chat opens it only for the people it is shared with. If someone sent you this link, ask them to add you from the chat&apos;s Share
          option, then open the link again.
        </p>
        <p className="text-[13px] text-asst-muted">It may also have been deleted, or its owner may have stopped sharing it.</p>
        <Link href={SHARED_CHATS} className="text-[13px] text-asst-accent underline hover:text-asst-accent-hover">
          See the chats that are shared with you
        </Link>
      </div>
    </div>
  );
}
