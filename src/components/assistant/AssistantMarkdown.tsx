import type { ReactNode } from "react";
import { Markup, type MarkupTheme } from "@/components/Markup";

/**
 * The assistant's answers and documents, rendered from the hub's markdown subset in the Assistant's own styles.
 * Everything structural is in `Markup`, which both surfaces share; what differs here is the token set, the type
 * scale, and that a `#1234` message reference has no meaning to this reader and stays as text.
 */

/** A document's headings are real headings, under the panel's own; an answer's are bold lines, as in the hub. */
function Heading({ level, document, children }: { level: number; document: boolean; children: ReactNode }) {
  if (!document) {
    return <p className="font-semibold text-asst-text">{children}</p>;
  }
  if (level <= 1) {
    return <h3 className="text-[22px] font-semibold tracking-tight text-asst-text">{children}</h3>;
  }
  if (level === 2) {
    return <h4 className="pt-3 text-[18px] font-semibold text-asst-text">{children}</h4>;
  }
  return <h5 className="pt-2 text-base font-semibold text-asst-text">{children}</h5>;
}

function assistantTheme(document: boolean): MarkupTheme {
  return {
    // The space before the interpolation is load-bearing: Tailwind's scanner does not see a class written up against
    // a `${`, and silently generates no rule for it.
    container: `flex flex-col gap-3 whitespace-pre-wrap break-words leading-relaxed ${document ? "text-[15px]" : ""}`,
    code: "whitespace-pre-wrap rounded-sm bg-asst-active px-1.5 py-px font-plex-mono text-[0.9em]",
    strong: "font-semibold text-asst-text",
    link: "text-asst-accent underline hover:text-asst-accent-hover",
    ordered: "flex list-decimal flex-col gap-1 pl-6",
    unordered: "flex list-disc flex-col gap-1 pl-6",
    fence: "overflow-x-auto whitespace-pre rounded-lg bg-asst-rail px-3 py-2 font-plex-mono text-[13px] leading-5",
    fenceLabel: "",
    tableScroller: "overflow-x-auto rounded-lg",
    cell: "border border-asst-line px-2 py-1 align-top",
    header: "bg-asst-raised font-semibold text-asst-text",
    messageRef: (id) => `#${id}`,
    heading: (level, children) => (
      <Heading level={level} document={document}>
        {children}
      </Heading>
    ),
    fenceLanguage: false
  };
}

// Built once each: a theme is read on every render and holds nothing per-message.
const ANSWER = assistantTheme(false);
const DOCUMENT = assistantTheme(true);

export function AssistantMarkdown({ source, document = false, repoBase = null }: { source: string; document?: boolean; repoBase?: string | null }) {
  return <Markup source={source} theme={document ? DOCUMENT : ANSWER} repoBase={repoBase} />;
}
