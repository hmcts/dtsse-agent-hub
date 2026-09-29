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
  | { type: "link"; href: string; children: Inline[] };

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

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "code"; language: string | null; text: string }
  | ListBlock;

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
const LANGUAGE = /^[\w+#.-]{1,32}$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(\S.*)$/;
const NUMBERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(\S.*)$/;

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

function startsBlock(line: string): boolean {
  return openFence(line) !== null || HEADING.test(line) || listItem(line) !== null;
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

/** A body as blocks: fenced code, headings, lists and paragraphs. A paragraph keeps its line breaks. */
export function parseMarkup(source: string): Block[] {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];
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
    const start = i;
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) {
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

/** Inline code, bold, italics and links within one block. Everything else, line breaks included, stays as text. */
export function parseInline(text: string): Inline[] {
  return parseRange(text, 0, text.length, 0, true);
}
