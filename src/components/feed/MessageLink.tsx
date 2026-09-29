import Link from "next/link";
import { messageHref } from "@/messages/permalink";

/** The quiet style for an id in a byline. Underlined, because a link told apart by colour alone fails WCAG 1.4.1. */
export const BYLINE_ID = "text-xs text-hub-muted underline decoration-dotted underline-offset-2 hover:text-white";

/** A message's id as `#1234`, linking to its page, which answers not-found for a message the viewer may not read. */
export function MessageLink({ id, className = "text-hub-link underline hover:no-underline" }: { id: string; className?: string }) {
  return (
    <Link href={messageHref(id)} className={className}>
      #{id}
    </Link>
  );
}
