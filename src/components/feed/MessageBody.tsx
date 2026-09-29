import type { ReactNode } from "react";
import { MessageLink } from "@/components/feed/MessageLink";
import { type Block, type Inline, type ListBlock, parseMarkup } from "@/messages/markup";

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return (
          <code key={index} className="rounded border border-hub-line bg-hub-raised px-1 font-mono text-[13px] text-hub-text">
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={index} className="font-bold text-white">
            {renderInline(node.children)}
          </strong>
        );
      case "emphasis":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "message":
        return <MessageLink key={index} id={node.id} />;
    }
    return (
      <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className="text-hub-link underline hover:no-underline">
        {renderInline(node.children)}
      </a>
    );
  });
}

function List({ list }: { list: ListBlock }) {
  const items = list.items.map((item, index) => (
    <li key={index}>
      {renderInline(item.children)}
      {item.lists.map((nested, inner) => (
        <List key={inner} list={nested} />
      ))}
    </li>
  ));
  return list.ordered ? (
    <ol start={list.start} className="list-decimal pl-6">
      {items}
    </ol>
  ) : (
    <ul className="list-disc pl-6">{items}</ul>
  );
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p key={index}>{renderInline(block.children)}</p>;
    // Bold text rather than h1–h6, so a message cannot break the page's heading outline.
    case "heading":
      return (
        <p key={index} className="font-bold text-white">
          {renderInline(block.children)}
        </p>
      );
    case "code":
      return (
        <div key={index}>
          {block.language ? <span className="block text-xs text-hub-muted">{block.language}</span> : null}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard user needs focus to scroll a long line into view, which axe checks as scrollable-region-focusable */}
          <pre tabIndex={0} className="overflow-x-auto whitespace-pre rounded-md border border-hub-line bg-hub-rail px-3 py-2 font-mono text-[13px] leading-5">
            <code {...(block.language ? { "data-language": block.language } : {})}>{block.text}</code>
          </pre>
        </div>
      );
    case "list":
      return <List key={index} list={block} />;
  }
}

/**
 * A message body rendered from its markdown subset as React elements. Bodies come from agents and people across the
 * organisation, so this never renders HTML: `parseMarkup` yields only text and allow-listed links.
 */
export function MessageBody({ body }: { body: string }) {
  return (
    <div className="space-y-1 whitespace-pre-wrap break-words text-[15px] leading-[22px] text-hub-text">
      {parseMarkup(body).map((block, index) => renderBlock(block, index))}
    </div>
  );
}
