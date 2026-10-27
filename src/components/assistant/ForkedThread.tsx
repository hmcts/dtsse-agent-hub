import type { ForkedView } from "@/assistant/forks";
import { SharedItem } from "@/components/assistant/SharedItem";

/**
 * The part of a forked chat that was copied from someone else's: whose it was, and what was said in it before the
 * copy was taken. Shown above the copy's own thread, and set apart from it, because none of it was said by the person
 * reading or in their own assistant's session — the "asked" turns are the other person's.
 */
export function ForkedThread({ forked }: { forked: ForkedView }) {
  const day = forked.at.slice(0, 10);
  return (
    <section aria-label={`Copied from ${forked.fromOwnerName}'s chat`} className="flex flex-col gap-[26px]">
      <p className="rounded-lg border border-asst-line px-3 py-2 text-center text-[13px] text-asst-muted">
        Forked from {forked.fromOwnerName}&rsquo;s conversation &ldquo;{forked.fromTitle}&rdquo; on <time dateTime={forked.at}>{day}</time>. What follows down
        to the line was said in their chat.
        {forked.earlierHidden ? " Its start was too long to copy, so it begins part-way through." : ""}
      </p>
      {forked.thread.length === 0 ? (
        <p className="text-center text-[13px] text-asst-muted">Nothing had been said in it yet.</p>
      ) : (
        <ol aria-label="Copied conversation" className="flex flex-col gap-[26px]">
          {forked.thread.map((item) => (
            <SharedItem key={item.key} item={item} />
          ))}
        </ol>
      )}
      <p className="flex items-center gap-3 text-xs text-asst-faint">
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
        Your copy starts here
        <span aria-hidden="true" className="h-px flex-1 bg-asst-line" />
      </p>
    </section>
  );
}
