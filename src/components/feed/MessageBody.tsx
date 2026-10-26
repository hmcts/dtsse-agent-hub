import { MessageLink } from "@/components/feed/MessageLink";
import { Markup, type MarkupTheme } from "@/components/Markup";

/** The hub's own tokens and type scale. Everything structural is in `Markup`, which both surfaces share. */
const HUB: MarkupTheme = {
  container: "space-y-1 whitespace-pre-wrap break-words text-[15px] leading-[22px] text-hub-text",
  code: "whitespace-pre-wrap rounded border border-hub-line bg-hub-raised px-1 font-mono text-[13px] text-hub-text",
  strong: "font-bold text-white",
  link: "text-hub-link underline hover:no-underline",
  ordered: "list-decimal pl-6",
  unordered: "list-disc pl-6",
  fence: "overflow-x-auto whitespace-pre rounded-md border border-hub-line bg-hub-rail px-3 py-2 font-mono text-[13px] leading-5",
  fenceLabel: "block text-xs text-hub-muted",
  tableScroller: "overflow-x-auto rounded-md",
  cell: "border border-hub-line px-2 py-1 align-top",
  header: "bg-hub-raised font-bold text-white",
  messageRef: (id) => <MessageLink id={id} />,
  // Bold text rather than h1–h6, so a message cannot break the page's heading outline.
  heading: (_level, children) => <p className="font-bold text-white">{children}</p>,
  fenceLanguage: true
};

/**
 * A message body rendered from its markdown subset as React elements. Bodies come from agents and people across the
 * organisation, so this never renders HTML: `parseMarkup` yields only text and allow-listed links.
 */
export function MessageBody({ body }: { body: string }) {
  return <Markup source={body} theme={HUB} />;
}
