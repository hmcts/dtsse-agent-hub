import type { ReactNode } from "react";
import { type Block, type Inline, type ListBlock, parseMarkup, type TableBlock } from "@/messages/markup";

/**
 * The assistant's answers and documents, rendered from the hub's markdown subset in the Assistant's own styles. As
 * in the hub, nothing here renders HTML: `parseMarkup` yields only text and allow-listed links. A `#1234` message
 * reference has no meaning to this reader and stays as text.
 */

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return (
          // A code span keeps its own spacing wherever it sits, so the same span reads the same in a paragraph and in
          // a table cell, which sets `whitespace-normal` for its text.
          <code key={index} className="whitespace-pre-wrap rounded bg-asst-active px-1.5 py-px font-plex-mono text-[0.9em]">
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={index} className="font-semibold text-asst-text">
            {renderInline(node.children)}
          </strong>
        );
      case "emphasis":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "message":
        return `#${node.id}`;
    }
    return (
      <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className="text-asst-accent underline hover:text-asst-accent-hover">
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
    <ol start={list.start} className="flex list-decimal flex-col gap-1 pl-6">
      {items}
    </ol>
  ) : (
    <ul className="flex list-disc flex-col gap-1 pl-6">{items}</ul>
  );
}

const ALIGNMENT = { left: "text-left", center: "text-center", right: "text-right" } as const;

function Table({ table }: { table: TableBlock }) {
  // A column the delimiter row left alone reads left, which a `th` would otherwise centre.
  const cell = (column: number) => `border border-asst-line px-2 py-1 align-top ${ALIGNMENT[table.align[column] ?? "left"]}`;
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard user needs focus to scroll a wide table into view, which axe checks as scrollable-region-focusable
    <div tabIndex={0} className="overflow-x-auto rounded-lg">
      {/* Cell text wraps as normal text: the container's `whitespace-pre-wrap` would keep the runs of spaces an author padded their pipes with. A code span sets its own, so only the padding collapses. */}
      <table className="min-w-full border-collapse whitespace-normal text-[13px] leading-5">
        <thead>
          <tr>
            {table.header.map((children, column) => (
              <th key={column} scope="col" className={`${cell(column)} bg-asst-raised font-semibold text-asst-text`}>
                {renderInline(children)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index}>
              {row.map((children, column) => (
                <td key={column} className={cell(column)}>
                  {renderInline(children)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

function renderBlock(block: Block, index: number, document: boolean): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p key={index}>{renderInline(block.children)}</p>;
    case "heading":
      return (
        <Heading key={index} level={block.level} document={document}>
          {renderInline(block.children)}
        </Heading>
      );
    case "code":
      return (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard user needs focus to scroll a long line into view, which axe checks as scrollable-region-focusable
        <pre key={index} tabIndex={0} className="overflow-x-auto whitespace-pre rounded-lg bg-asst-rail px-3 py-2 font-plex-mono text-[13px] leading-5">
          <code>{block.text}</code>
        </pre>
      );
    case "list":
      return <List key={index} list={block} />;
    case "table":
      return <Table key={index} table={block} />;
    default:
      return noCaseFor(block);
  }
}

/**
 * Every block `parseMarkup` yields must have a case above. `block` is `never` only while the switch is total, so a
 * block type added to the parser fails the typecheck here rather than rendering as nothing and dropping an answer's
 * content without a trace.
 */
function noCaseFor(block: never): never {
  throw new Error(`AssistantMarkdown has no case for the ${(block as Block).type} block`);
}

export function AssistantMarkdown({ source, document = false }: { source: string; document?: boolean }) {
  return (
    <div className={`flex flex-col whitespace-pre-wrap break-words ${document ? "gap-3 text-[15px] leading-relaxed" : "gap-3 leading-relaxed"}`}>
      {parseMarkup(source).map((block, index) => renderBlock(block, index, document))}
    </div>
  );
}
