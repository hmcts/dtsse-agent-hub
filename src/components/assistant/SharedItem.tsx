import type { SharedThreadItem } from "@/assistant/sharing";
import { AssistantMarkdown } from "@/components/assistant/AssistantMarkdown";
import { Mark } from "@/components/assistant/AssistantShell";

function files(count: number): string {
  return count === 1 ? "1 file sent with this message" : `${count} files sent with this message`;
}

/** One item of a thread someone else wrote, as a share and a copy's earlier part both show it. */
export function SharedItem({ item }: { item: SharedThreadItem }) {
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
