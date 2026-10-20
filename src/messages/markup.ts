import { parseMessageRef } from "./permalink.ts";

/**
 * A small markdown subset for message bodies, parsed into a tree the UI renders as React elements. Bodies are written
 * by agents and people across the organisation, so nothing here produces HTML: every leaf is text, and a link is only
 * kept when its scheme is on the allow-list.
 *
 * Every scan is linear in the body's length. Searches for a closing marker are memoised so a run of unmatched openers
 * cannot rescan the rest of the body once per opener.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "emphasis"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  /** A `#1234` reference to another message, which the UI links to that message's page. */
  | { type: "message"; id: string };

export interface ListItem {
  children: Inline[];
  lists: ListBlock[];
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  start: number;
  items: ListItem[];
}

/** A column's alignment, from the delimiter row's colons, or null when it asked for none. */
export type Alignment = "left" | "center" | "right" | null;

export interface TableBlock {
  type: "table";
  /** One entry per column, so a row's cells and the alignments line up by index. */
  align: Alignment[];
  header: Inline[][];
  rows: Inline[][][];
}

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; language: string | null; text: string }
  | ListBlock
  | TableBlock;

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The normalised URL when it is absolute and its scheme is http, https or mailto; otherwise null. */
export function safeHref(raw: string): string | null {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
}

const MAX_LIST_DEPTH = 4;
const MAX_INLINE_DEPTH = 3;
// Bounds the work a run of `[x](` openers sharing one distant `)` can cause.
const MAX_LINK_URL = 2048;
// Bounds how wide one row can get. A header with more columns than this opens no table at all, because truncating it
// would drop the columns it names.
const MAX_TABLE_COLUMNS = 64;
// Bounds the cells every table in one body holds between them, and so the elements the UI renders for it. Rows are
// padded to the header's width, so without this a short body of one-cell rows under a wide header multiplies into
// millions of cells: 64 columns over 16,000 such rows is a 32KB body and a 68MB render. Tables stop opening once a
// body has spent it, and the lines that would have been rows stay text, so nothing an author wrote is dropped.
const MAX_TABLE_CELLS = 4096;
const LANGUAGE = /^[\w+#.-]{1,32}$/;
const DELIMITER_CELL = /^:?-+:?$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(\S.*)$/;
const NUMBERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(\S.*)$/;
// A cell holds a value, and a value can start with one of the markers above: `-` for none, or `1. open` for a step.
// A marker and more than one word reads as a sentence instead.
const MARKER_CELL = /^([-*+]|\d{1,9}[.)])([ \t]+\S+)?$/;
const TRAILING_BACKSLASHES = /\\+$/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") {
      width += 1;
    } else if (char === "\t") {
      width += 4;
    } else {
      break;
    }
  }
  return width;
}

interface Fence {
  ticks: number;
  indent: number;
  language: string | null;
}

function openFence(line: string): Fence | null {
  const trimmed = line.trimStart();
  let ticks = 0;
  while (trimmed[ticks] === "`") {
    ticks++;
  }
  const info = trimmed.slice(ticks);
  // A backtick in the info string means this is inline code at the start of a line, not a fence.
  if (ticks < 3 || info.includes("`")) {
    return null;
  }
  const language = info.trim().split(/\s/)[0] ?? "";
  return { ticks, indent: indentOf(line), language: LANGUAGE.test(language) ? language : null };
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.ticks && /^`+$/.test(trimmed);
}

function stripIndent(line: string, width: number): string {
  let i = 0;
  while (i < width && line[i] === " ") {
    i++;
  }
  return line.slice(i);
}

function headingText(raw: string): string {
  const text = raw.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") {
    end--;
  }
  if (end === text.length) {
    return text;
  }
  if (end === 0) {
    return "";
  }
  // `## Title ##` drops its closing hashes; `# C#` keeps the one that is part of the word.
  return text[end - 1] === " " || text[end - 1] === "\t" ? text.slice(0, end).trimEnd() : text;
}

interface FlatItem {
  indent: number;
  ordered: boolean;
  number: number;
  lines: string[];
}

function listItem(line: string): FlatItem | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    return { indent: indentOf(bullet[1]!), ordered: false, number: 1, lines: [bullet[2]!] };
  }
  const numbered = NUMBERED.exec(line);
  if (numbered) {
    return { indent: indentOf(numbered[1]!), ordered: true, number: Number(numbered[2]), lines: [numbered[3]!] };
  }
  return null;
}

interface Backslashes {
  /** The literal backslashes the run stands for. */
  text: string;
  /** Whether the run spends its odd backslash escaping the `|` after it, so that pipe is content and not a break. */
  pipe: boolean;
  /** Where the line carries on, past everything the run accounts for. */
  next: number;
}

/**
 * What the run of backslashes at `at` means. A cell's escapes exist only to hold a `|`, which has to be written `\|`
 * because cells are split before anything inline is parsed, as GFM does, so a bare `|` in a code span ends its cell.
 * A run therefore only escapes anything where it ends at a `|`: each pair there stands for one literal backslash, and
 * an odd backslash left over escapes the pipe. A run anywhere else is content and is kept exactly as it was written,
 * so a cell holding `C:\\Users\me` or `` `\\d+` `` reaches the reader with every backslash the author typed.
 */
function backslashes(line: string, at: number): Backslashes {
  let end = at;
  while (line[end] === "\\") {
    end++;
  }
  if (line[end] !== "|") {
    return { text: line.slice(at, end), pipe: false, next: end };
  }
  const pipe = (end - at) % 2 === 1;
  return { text: "\\".repeat((end - at) >> 1), pipe, next: pipe ? end + 1 : end };
}

/** Whether the line holds a cell break: a `|` that no backslash before it escapes. */
function hasCellBreak(line: string): boolean {
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\\") {
      i = backslashes(line, i).next;
      continue;
    }
    if (line[i] === "|") {
      return true;
    }
    i++;
  }
  return false;
}

/**
 * The row's cells, each with its escapes resolved, split on the breaks `hasCellBreak` counts and with the optional
 * outer pipes dropped. One scan both splits and resolves, so where a break is and what a backslash before it meant
 * are the same decision. Unlike GFM the escapes are undone inside code spans too, because the subset has no other
 * backslash escape and `` `a \| b` `` is meant as one cell holding `a | b`.
 */
function rowCells(line: string): string[] {
  const row = line.trim();
  const cells: string[] = [];
  let text = "";
  let from = 0;
  let i = 0;
  while (i < row.length) {
    if (row[i] === "\\") {
      const run = backslashes(row, i);
      text += row.slice(from, i) + run.text + (run.pipe ? "|" : "");
      i = run.next;
      from = i;
      continue;
    }
    if (row[i] === "|") {
      cells.push(text + row.slice(from, i));
      text = "";
      i++;
      from = i;
      continue;
    }
    i++;
  }
  cells.push(text + row.slice(from));
  if (cells.length > 1 && cells[0] === "" && row.startsWith("|")) {
    cells.shift();
  }
  if (cells.length > 1 && cells[cells.length - 1] === "" && row.endsWith("|")) {
    cells.pop();
  }
  return cells;
}

/** A cell's inline markup. `rowCells` has resolved its escapes; the spaces its pipes were padded with go here. */
function cellInlines(cell: string): Inline[] {
  return parseInline(cell.trim());
}

/**
 * The columns' alignments when these two lines open a table: a row of cells over a delimiter row of `-` runs with
 * optional colons. GFM only starts a table when the delimiter row has exactly as many cells as the header, and that is
 * what keeps a paragraph of pipe-separated prose a paragraph. Past `MAX_TABLE_COLUMNS` columns the lines stay a
 * paragraph, so every cell an author wrote is still in the output.
 */
function tableHead(header: string, delimiter: string | undefined): Alignment[] | null {
  if (delimiter === undefined || !hasCellBreak(header) || !hasCellBreak(delimiter)) {
    return null;
  }
  const cells = rowCells(delimiter);
  if (cells.length !== rowCells(header).length || cells.length > MAX_TABLE_COLUMNS) {
    return null;
  }
  const align: Alignment[] = [];
  for (const cell of cells) {
    const text = cell.trim();
    if (!DELIMITER_CELL.test(text)) {
      return null;
    }
    const left = text.startsWith(":");
    const right = text.endsWith(":");
    align.push(left && right ? "center" : left ? "left" : right ? "right" : null);
  }
  return align;
}

/**
 * Whether the line starts a block of its own, ending any paragraph above it. A table also needs the line after it,
 * so it only opens where a caller passes one: an indented pipe table inside a list item stays part of its item.
 */
function startsBlock(line: string, next?: string): boolean {
  return openFence(line) !== null || HEADING.test(line) || listItem(line) !== null || tableHead(line, next) !== null;
}

/**
 * The row's cells, with any past the table's width merged back into its last cell, the pipes between them included.
 * A merged cell is shown as the author wrote it, so a backslash run that ends one is escaped again: left as the single
 * backslash it resolved to, it would read as escaping the pipe that now follows it.
 */
function fitRow(cells: string[], columns: number): string[] {
  if (cells.length <= columns) {
    return cells;
  }
  const overflow = cells.slice(columns - 1);
  const last = overflow.pop()!;
  const merged = [...overflow.map((cell) => cell.replace(TRAILING_BACKSLASHES, (run) => run.repeat(2))), last].join("|");
  return [...cells.slice(0, columns - 1), merged];
}

/**
 * Whether a line below a table's rows opens a block of its own instead of being another row, given its first cell. A
 * heading does: a row carrying its outer pipes cannot read as one, and `#` and a space is not how a cell's value
 * starts. A list item does unless its first cell is a marker and at most one word, which is a cell's worth of content:
 * `- | none` is a column of flags and `1. open | the page` a column of steps, while `- use \`a | b\` for X` is a
 * bullet that happens to hold a pipe.
 */
function endsRows(line: string, first: string): boolean {
  if (HEADING.test(line)) {
    return true;
  }
  return listItem(line) !== null && !MARKER_CELL.test(first.trim());
}

/**
 * The table these lines open, from the header at `from`, and the cells it holds. It takes no more cells than `budget`,
 * which is what is left of the body's `MAX_TABLE_CELLS`.
 *
 * What ends the table is a line that cannot be one of its rows, or the budget running out: a blank line, a fence, a
 * line with no cell break, a heading, or a list item that `endsRows` reads as prose rather than a cell. Short of
 * those a cell break wins, so `- | none` is a column of flags and not a bullet. GFM ends a table at the beginning of
 * any block-level structure, which would make that line a bullet holding `| none`. A line with more cells than the table
 * has columns is still a row: its overflow stays in its last cell, pipes and all, so the one likely mistake here, an
 * unescaped `|` in a cell, costs that cell its spacing rather than ending the table and leaving every row below it as
 * literal text. GFM truncates such a row, which would drop the author's words.
 */
function parseTable(lines: string[], from: number, align: Alignment[], budget: number): { table: TableBlock; next: number; cells: number } {
  const columns = align.length;
  const table: TableBlock = { type: "table", align, header: rowCells(lines[from]!).map(cellInlines), rows: [] };
  let cells = columns;
  let i = from + 2;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line) || openFence(line) !== null || !hasCellBreak(line) || cells + columns > budget) {
      break;
    }
    const split = rowCells(line);
    if (endsRows(line, split[0]!)) {
      break;
    }
    const row = fitRow(split, columns).map(cellInlines);
    // GFM pads a short row, so every row is as wide as the header.
    while (row.length < columns) {
      row.push([]);
    }
    table.rows.push(row);
    cells += columns;
    i++;
  }
  return { table, next: i, cells };
}

interface Level {
  indent: number;
  list: ListBlock;
  container: ListBlock[];
}

function nestLists(flat: FlatItem[]): ListBlock[] {
  const root: ListBlock[] = [];
  const stack: Level[] = [];
  for (const item of flat) {
    while (stack.length > 0 && item.indent < stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const entry: ListItem = { children: parseInline(item.lines.join("\n")), lists: [] };
    const top = stack[stack.length - 1];
    if (top && (item.indent === top.indent || stack.length >= MAX_LIST_DEPTH) && item.ordered === top.list.ordered) {
      top.list.items.push(entry);
      continue;
    }
    const list: ListBlock = { type: "list", ordered: item.ordered, start: item.number, items: [entry] };
    if (top && item.indent > top.indent && stack.length < MAX_LIST_DEPTH) {
      const parent = top.list.items[top.list.items.length - 1]!;
      parent.lists.push(list);
      stack.push({ indent: item.indent, list, container: parent.lists });
    } else {
      // The same level with the other kind of marker starts a sibling list.
      const container = top ? top.container : root;
      container.push(list);
      if (top) {
        stack.pop();
      }
      stack.push({ indent: top ? top.indent : item.indent, list, container });
    }
  }
  return root;
}

function parseList(lines: string[], from: number, blocks: Block[]): number {
  const flat: FlatItem[] = [];
  let i = from;
  while (i < lines.length) {
    const line = lines[i]!;
    const item = listItem(line);
    if (item) {
      flat.push(item);
      i++;
      continue;
    }
    if (isBlank(line)) {
      let next = i;
      while (next < lines.length && isBlank(lines[next]!)) {
        next++;
      }
      if (next < lines.length && listItem(lines[next]!) !== null) {
        i = next;
        continue;
      }
      break;
    }
    if (indentOf(line) > 0 && !startsBlock(line)) {
      flat[flat.length - 1]!.lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  blocks.push(...nestLists(flat));
  return i;
}

/** A body as blocks: fenced code, headings, lists, pipe tables and paragraphs. A paragraph keeps its line breaks. */
export function parseMarkup(source: string): Block[] {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];
  // Shared by every table in the body, so a run of wide tables cannot cost more than one of them.
  let budget = MAX_TABLE_CELLS;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = openFence(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i]!, fence)) {
        body.push(stripIndent(lines[i]!, fence.indent));
        i++;
      }
      // An unterminated fence runs to the end of the body.
      i++;
      blocks.push({ type: "code", language: fence.language, text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, children: parseInline(headingText(heading[2]!)) });
      i++;
      continue;
    }
    if (listItem(line)) {
      i = parseList(lines, i, blocks);
      continue;
    }
    const align = tableHead(line, lines[i + 1]);
    // A table only opens while the body has room for its header; once the budget is spent the lines stay text.
    if (align && align.length <= budget) {
      const { table, next, cells } = parseTable(lines, i, align, budget);
      blocks.push(table);
      budget -= cells;
      i = next;
      continue;
    }
    const start = i;
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!, lines[i + 1])) {
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(lines.slice(start, i).join("\n")) });
  }
  return blocks;
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

const OPEN_PUNCTUATION = "([{\"'";
const CLOSE_PUNCTUATION = ".,;:!?)]}\"'";

/**
 * Emphasis markers only count at a word boundary, so `snake_case`, `a*b*c` and `src/**` stay as they are. A run of
 * the other emphasis marker counts as a boundary so the two can nest.
 */
function opensAfter(char: string | undefined): boolean {
  return char === undefined || isSpace(char) || OPEN_PUNCTUATION.includes(char) || char === "*" || char === "_";
}

function closesBefore(char: string | undefined): boolean {
  return char === undefined || isSpace(char) || CLOSE_PUNCTUATION.includes(char) || char === "*" || char === "_";
}

/**
 * The first position at or after `from` where `marker` occurs, ends by `end` and passes `valid`, or -1. `valid` must
 * depend only on the position, not on where the search began; that is what lets a result answer every later search
 * that starts at or before it, and keeps repeated searches linear overall.
 */
function finder(text: string, end: number, marker: string, valid: (at: number) => boolean): (from: number) => number {
  let searchedFrom = Number.POSITIVE_INFINITY;
  let found = -1;
  return (from) => {
    if (from >= searchedFrom && (found === -1 || from <= found)) {
      return found;
    }
    let at = from;
    for (;;) {
      at = text.indexOf(marker, at);
      if (at === -1 || at + marker.length > end) {
        at = -1;
        break;
      }
      if (valid(at)) {
        break;
      }
      at++;
    }
    searchedFrom = from;
    found = at;
    return at;
  };
}

const URL_STOP = new Set(["<", ">", '"', "`"]);
const URL_TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*", "_", "]"]);

function urlEnd(text: string, from: number, end: number): number {
  let at = from;
  let open = 0;
  let close = 0;
  while (at < end && !isSpace(text[at]) && !URL_STOP.has(text[at]!)) {
    if (text[at] === "(") {
      open++;
    } else if (text[at] === ")") {
      close++;
    }
    at++;
  }
  for (;;) {
    const last = text[at - 1]!;
    if (URL_TRAILING.has(last)) {
      at--;
    } else if (last === ")" && close > open) {
      close--;
      at--;
    } else {
      return at;
    }
  }
}

function pushText(out: Inline[], text: string): void {
  if (text === "") {
    return;
  }
  out.push({ type: "text", text });
}

function codeSpan(raw: string): string {
  return raw.length > 2 && raw.startsWith(" ") && raw.endsWith(" ") && raw.trim() !== "" ? raw.slice(1, -1) : raw;
}

function parseRange(text: string, start: number, end: number, depth: number, links: boolean): Inline[] {
  const out: Inline[] = [];
  const emphasis = depth < MAX_INLINE_DEPTH;
  // The range is all a nested parse may look at, so a marker just outside it neither opens nor closes anything.
  const charAt = (at: number): string | undefined => (at >= start && at < end ? text[at] : undefined);
  const closesEmphasis = (marker: string) => (at: number) =>
    !isSpace(charAt(at - 1)) && charAt(at - 1) !== marker && charAt(at + 1) !== marker && closesBefore(charAt(at + 1));
  const strongCloser = finder(text, end, "**", (at) => !isSpace(charAt(at - 1)) && charAt(at + 2) !== "*" && closesBefore(charAt(at + 2)));
  const starCloser = finder(text, end, "*", closesEmphasis("*"));
  const underscoreCloser = finder(text, end, "_", closesEmphasis("_"));
  const bracketCloser = finder(text, end, "]", () => true);
  const parenCloser = finder(text, end, ")", () => true);
  const unmatchedTicks = new Set<number>();
  let rejectedBracket = -1;
  let plain = start;
  let i = start;

  const emit = (node: Inline, from: number, to: number): void => {
    pushText(out, text.slice(plain, from));
    out.push(node);
    i = to;
    plain = to;
  };

  while (i < end) {
    const char = text[i];

    if (char === "`") {
      let run = i;
      while (run < end && text[run] === "`") {
        run++;
      }
      const ticks = run - i;
      let close = -1;
      if (!unmatchedTicks.has(ticks)) {
        let at = run;
        while (at < end) {
          at = text.indexOf("`", at);
          if (at === -1 || at >= end) {
            break;
          }
          let length = 0;
          while (at + length < end && text[at + length] === "`") {
            length++;
          }
          if (length === ticks) {
            close = at;
            break;
          }
          at += length;
        }
        if (close === -1) {
          unmatchedTicks.add(ticks);
        }
      }
      if (close === -1) {
        i = run;
      } else {
        emit({ type: "code", text: codeSpan(text.slice(run, close)) }, i, close + ticks);
      }
      continue;
    }

    if (emphasis && char === "*" && charAt(i + 1) === "*" && i + 2 < end) {
      if (opensAfter(charAt(i - 1)) && !isSpace(charAt(i + 2))) {
        const close = strongCloser(i + 3);
        if (close !== -1) {
          emit({ type: "strong", children: parseRange(text, i + 2, close, depth + 1, links) }, i, close + 2);
          continue;
        }
      }
      i += 2;
      continue;
    }

    if (emphasis && (char === "*" || char === "_")) {
      const next = charAt(i + 1);
      if (opensAfter(charAt(i - 1)) && next !== undefined && !isSpace(next) && next !== char) {
        const close = (char === "*" ? starCloser : underscoreCloser)(i + 2);
        if (close !== -1) {
          emit({ type: "emphasis", children: parseRange(text, i + 1, close, depth + 1, links) }, i, close + 1);
          continue;
        }
      }
      i++;
      continue;
    }

    if (links && char === "[") {
      const bracket = bracketCloser(i + 1);
      if (bracket !== -1 && bracket !== rejectedBracket && charAt(bracket + 1) === "(") {
        const paren = parenCloser(bracket + 2);
        const href = paren === -1 || paren - bracket - 2 > MAX_LINK_URL ? null : safeHref(text.slice(bracket + 2, paren));
        if (href !== null) {
          const children = bracket > i + 1 ? parseRange(text, i + 1, bracket, depth + 1, false) : [{ type: "text" as const, text: href }];
          emit({ type: "link", href, children }, i, paren + 1);
          continue;
        }
        rejectedBracket = bracket;
      }
      i++;
      continue;
    }

    // Only a whole word counts, so `issue#12`, `#12a`, `&#12;` and `path/#12` stay as text. A link's text is parsed
    // without links, so a reference is never a link inside a link.
    if (links && char === "#" && !isWordChar(charAt(i - 1)) && charAt(i - 1) !== "&" && charAt(i - 1) !== "/") {
      let stop = i + 1;
      while (stop < end && stop - i <= 20 && isDigit(text[stop])) {
        stop++;
      }
      const id = isWordChar(charAt(stop)) ? null : parseMessageRef(text.slice(i + 1, stop));
      if (id !== null) {
        emit({ type: "message", id: id.toString() }, i, stop);
      } else {
        i = stop;
      }
      continue;
    }

    if (links && char === "h" && !isWordChar(charAt(i - 1)) && charAt(i - 1) !== "/") {
      const scheme = text.startsWith("https://", i) ? 8 : text.startsWith("http://", i) ? 7 : 0;
      if (scheme > 0 && i + scheme < end) {
        const stop = urlEnd(text, i, end);
        const raw = text.slice(i, stop);
        const href = stop > i + scheme ? safeHref(raw) : null;
        if (href !== null) {
          emit({ type: "link", href, children: [{ type: "text", text: raw }] }, i, stop);
        } else {
          i = Math.max(stop, i + scheme);
        }
        continue;
      }
    }

    i++;
  }
  pushText(out, text.slice(plain, end));
  return out;
}

/** Inline code, bold, italics, links and `#1234` message references within one block. Everything else, line breaks included, stays as text. */
export function parseInline(text: string): Inline[] {
  return parseRange(text, 0, text.length, 0, true);
}
