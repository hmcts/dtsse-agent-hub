import { Fragment, type ReactNode } from "react";
import { type Block, type Inline, type ListBlock, parseMarkup, type TableBlock } from "@/messages/markup";

/**
 * The one renderer for the markdown subset `parseMarkup` yields, shared by the hub's message bodies and the
 * Assistant's answers and documents. Bodies are written by agents and people across the organisation, so nothing
 * here renders HTML: the parser yields only text and allow-listed links.
 *
 * Structure and accessibility live here because they are what the two surfaces have to agree on, and what broke
 * twice while each kept its own copy: a `th`'s `scope`, the focus a keyboard user needs to scroll an overflowing
 * region, the alignment a cell takes by index, and a new link's `rel`. A `MarkupTheme` carries only what they are
 * each free to differ on — their own tokens and type scales, and whether a `#1234` reference or a fence's language
 * means anything to their reader.
 */

export interface MarkupTheme {
  /** Wraps every block, and sets the whitespace a table's cells opt out of. */
  container: string;
  /**
   * An inline code span, which has to set its own whitespace: a table's cells collapse the spaces an author padded
   * their pipes with, and without this a span inside one would silently lose the spacing it was written with.
   */
  code: string;
  strong: string;
  link: string;
  ordered: string;
  unordered: string;
  fence: string;
  fenceLabel: string;
  tableScroller: string;
  cell: string;
  header: string;
  /** A `#1234` reference: the hub links it to that message, and a reader who has no hub sees text. */
  messageRef: (id: string) => ReactNode;
  /** A heading at this level, which a surface renders as bold text wherever a real one would break its outline. */
  heading: (level: number, children: ReactNode) => ReactNode;
  /** Whether a fence's language is named to this reader, as a label above it and a `data-language` on it. */
  fenceLanguage: boolean;
}

function renderInline(nodes: Inline[], theme: MarkupTheme): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "code":
        return (
          <code key={index} className={theme.code}>
            {node.text}
          </code>
        );
      case "strong":
        return (
          <strong key={index} className={theme.strong}>
            {renderInline(node.children, theme)}
          </strong>
        );
      case "emphasis":
        return <em key={index}>{renderInline(node.children, theme)}</em>;
      case "message":
        return <Fragment key={index}>{theme.messageRef(node.id)}</Fragment>;
    }
    return (
      <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className={theme.link}>
        {renderInline(node.children, theme)}
      </a>
    );
  });
}

function List({ list, theme }: { list: ListBlock; theme: MarkupTheme }) {
  const items = list.items.map((item, index) => (
    <li key={index}>
      {renderInline(item.children, theme)}
      {item.lists.map((nested, inner) => (
        <List key={inner} list={nested} theme={theme} />
      ))}
    </li>
  ));
  return list.ordered ? (
    <ol start={list.start} className={theme.ordered}>
      {items}
    </ol>
  ) : (
    <ul className={theme.unordered}>{items}</ul>
  );
}

/**
 * A region that scrolls when its content overflows. A wide table and a long code line both need the scroller itself
 * to take focus, or a keyboard user cannot reach what overflows; axe checks that as scrollable-region-focusable. The
 * `tabIndex` is therefore deliberate on an element that is not otherwise interactive, and `noNoninteractiveTabindex`
 * does not see it to object: the tag is a parameter, so the rule cannot tell which element it lands on.
 */
function ScrollPane({ as: Tag, className, children }: { as: "div" | "pre"; className: string; children: ReactNode }) {
  return (
    <Tag tabIndex={0} className={className}>
      {children}
    </Tag>
  );
}

const ALIGNMENT = { left: "text-left", center: "text-center", right: "text-right" } as const;

function Table({ table, theme }: { table: TableBlock; theme: MarkupTheme }) {
  // A column the delimiter row left alone reads left, which a `th` would otherwise centre.
  const cell = (column: number) => `${theme.cell} ${ALIGNMENT[table.align[column] ?? "left"]}`;
  return (
    <ScrollPane as="div" className={theme.tableScroller}>
      {/* Cell text wraps as normal text: the container's `whitespace-pre-wrap` would keep the runs of spaces an author padded their pipes with. A code span sets its own, so only the padding collapses. */}
      <table className="min-w-full border-collapse whitespace-normal text-[13px] leading-5">
        <thead>
          <tr>
            {table.header.map((children, column) => (
              <th key={column} scope="col" className={`${cell(column)} ${theme.header}`}>
                {renderInline(children, theme)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index}>
              {row.map((children, column) => (
                <td key={column} className={cell(column)}>
                  {renderInline(children, theme)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollPane>
  );
}

function Fence({ block, theme }: { block: Block & { type: "code" }; theme: MarkupTheme }) {
  const named = theme.fenceLanguage && block.language !== null;
  const pane = (
    <ScrollPane as="pre" className={theme.fence}>
      <code {...(named ? { "data-language": block.language } : {})}>{block.text}</code>
    </ScrollPane>
  );
  return named ? (
    <div>
      <span className={theme.fenceLabel}>{block.language}</span>
      {pane}
    </div>
  ) : (
    pane
  );
}

function renderBlock(block: Block, index: number, theme: MarkupTheme): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p key={index}>{renderInline(block.children, theme)}</p>;
    case "heading":
      return <Fragment key={index}>{theme.heading(block.level, renderInline(block.children, theme))}</Fragment>;
    case "code":
      return <Fence key={index} block={block} theme={theme} />;
    case "list":
      return <List key={index} list={block} theme={theme} />;
    case "table":
      return <Table key={index} table={block} theme={theme} />;
    default:
      return noCaseFor(block);
  }
}

/**
 * Every block `parseMarkup` yields must have a case above. `block` is `never` only while the switch is total, so a
 * block type added to the parser fails the typecheck here rather than rendering as nothing and dropping content from
 * every surface without a trace.
 */
function noCaseFor(block: never): never {
  throw new Error(`Markup has no case for the ${(block as Block).type} block`);
}

export function Markup({ source, theme }: { source: string; theme: MarkupTheme }) {
  return <div className={theme.container}>{parseMarkup(source).map((block, index) => renderBlock(block, index, theme))}</div>;
}
