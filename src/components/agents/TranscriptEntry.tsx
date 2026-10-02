import { Avatar } from "@/components/Avatar";
import { MessageBody } from "@/components/feed/MessageBody";
import { Timestamp } from "@/components/time/Timestamp";
import { oneLine, type TranscriptEntryView, toolSummary } from "@/transcripts/conversation";
import type { RedactedContent, TextContent, ToolResultContent, ToolUseContent } from "@/transcripts/schema";

const CHIP = "rounded border border-hub-line px-1 text-[11px] uppercase tracking-wide text-hub-muted";

function Truncated({ entry }: { entry: TranscriptEntryView }) {
  return entry.truncated ? <span className={CHIP}>truncated</span> : null;
}

/** `redacted` is the source of the secret pattern the client matched, shown as text and cut short on screen. */
function Hidden({ content }: { content: RedactedContent }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1 text-[13px] text-hub-muted">
      <span className="shrink-0 italic">hidden: matched secret pattern</span>
      <code title={content.redacted} className="truncate rounded border border-hub-line bg-hub-raised px-1 font-mono text-[12px] text-hub-text">
        {content.redacted}
      </code>
    </span>
  );
}

const OUTPUT = "mt-1 max-h-80 overflow-auto whitespace-pre rounded-md border bg-hub-rail px-3 py-2 font-mono text-[13px] leading-5";

function Output({ text, error = false }: { text: string; error?: boolean }) {
  const tone = error ? "border-red-800 text-red-300" : "border-hub-line text-hub-text";
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard user needs focus to scroll a long line into view, which axe checks as scrollable-region-focusable
    <pre tabIndex={0} className={`${OUTPUT} ${tone}`}>
      {text}
    </pre>
  );
}

/** A user or assistant turn: who said it, when, and what. */
function Turn({ entry, name, label }: { entry: TranscriptEntryView; name: string; label: string }) {
  return (
    <li className="flex gap-2 px-5 py-2 hover:bg-hub-raised" data-entry-id={entry.id}>
      <Avatar name={name} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 leading-5">
          <span className="text-[15px] font-bold text-white">{name}</span>
          <span className="text-xs text-hub-muted">{label}</span>
          <Timestamp iso={entry.occurred_at} className="text-xs text-hub-muted" />
          <Truncated entry={entry} />
        </p>
        {entry.redacted ? <Hidden content={entry.content as RedactedContent} /> : <MessageBody body={(entry.content as TextContent).text} />}
      </div>
    </li>
  );
}

/** A tool call or its result, collapsed to one line until opened. */
function Tool({ entry }: { entry: TranscriptEntryView }) {
  const redacted = entry.redacted ? (entry.content as RedactedContent) : null;
  let summary: React.ReactNode;
  let detail: React.ReactNode = null;
  let error = false;

  if (entry.role === "tool_use") {
    const call = entry.content as ToolUseContent & Partial<RedactedContent>;
    summary = (
      <>
        <span className="font-mono text-hub-text">{call.name ?? "tool"}</span>
        {redacted === null ? <span className="truncate text-hub-muted">{toolSummary(call.input)}</span> : <Hidden content={redacted} />}
      </>
    );
    if (redacted === null) {
      detail = <Output text={JSON.stringify(call.input ?? null, null, 2)} />;
    }
  } else {
    const result = entry.content as ToolResultContent;
    error = redacted === null && result.is_error;
    summary = (
      <>
        <span className={error ? "text-red-300" : "text-hub-text"}>{error ? "Error" : "Result"}</span>
        {redacted === null ? <span className="truncate text-hub-muted">{oneLine(result.output)}</span> : <Hidden content={redacted} />}
      </>
    );
    if (redacted === null) {
      detail = <Output text={result.output} error={error} />;
    }
  }

  return (
    <li className="px-5 py-0.5 pl-16" data-entry-id={entry.id}>
      {detail === null ? (
        <p className="flex min-w-0 items-baseline gap-2 text-[13px]">
          {summary}
          <Truncated entry={entry} />
        </p>
      ) : (
        <details className={`rounded border-l-2 pl-2 ${error ? "border-red-800" : "border-hub-line"}`}>
          <summary className="flex min-w-0 cursor-pointer items-baseline gap-2 text-[13px] hover:bg-hub-raised">
            {summary}
            <Truncated entry={entry} />
          </summary>
          {detail}
        </details>
      )}
    </li>
  );
}

function System({ entry }: { entry: TranscriptEntryView }) {
  return (
    <li className="flex items-baseline gap-2 px-5 py-0.5 pl-16 text-[13px] text-hub-muted" data-entry-id={entry.id}>
      <span className="shrink-0">System</span>
      {entry.redacted ? (
        <Hidden content={entry.content as RedactedContent} />
      ) : (
        <span className="whitespace-pre-wrap break-words">{(entry.content as TextContent).text}</span>
      )}
      <Truncated entry={entry} />
    </li>
  );
}

/** One entry of an agent's session transcript. `ownerName` is who types into the session; the agent answers. */
export function TranscriptEntry({ entry, agentName, ownerName }: { entry: TranscriptEntryView; agentName: string; ownerName: string }) {
  switch (entry.role) {
    case "user":
      return <Turn entry={entry} name={ownerName} label="in the session" />;
    case "assistant":
      return <Turn entry={entry} name={`@${agentName}`} label="replied" />;
    case "system":
      return <System entry={entry} />;
    default:
      return <Tool entry={entry} />;
  }
}
