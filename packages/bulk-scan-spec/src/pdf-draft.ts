import { noteFor } from "./hints.ts";
import type { Line, PdfContent, Widget } from "./pdf-extract.ts";
import type { Field } from "./schema.ts";

/** Where a checkbox option's label says to go next, as in "No > go to Section 5". */
export interface Route {
  kind: "section" | "question";
  /** The section number or the question id. */
  id: string;
  /** The route as the form words it, for the reviewer. */
  text: string;
}

/** One option of a checkbox or radio field: the key slot it ticks, and where the form sends the person who picks it. */
export interface Choice {
  /** The option's own words with the route removed. */
  label: string;
  /** Index into the field's keys. */
  slot: number;
  /** Whether picking this option ticks its key; "No" of a Yes/No pair leaves the pair's one key unticked. */
  ticked: boolean;
  route?: Route;
}

/** One field of the draft before keys and CCD ids are proposed. `slotLabels` has one entry per key the field will carry. */
export interface DraftField {
  page: number;
  sectionId: string;
  sectionTitle: string;
  /** The question's own words, for matching against existing keys and CCD ids. */
  question: string;
  field: Field;
  slotLabels: string[];
  /** The number of boxes in an XoR group, which a Yes/No pair keeps although it has one key. */
  groupSize?: number;
  /** The margin note the form prints beside the question, which may state the format an answer takes. */
  note?: string;
  /** The options of a checkbox or radio field, one per box. */
  choices?: Choice[];
  /** Why the field was grouped or typed as it was; empty when the PDF states it outright. */
  reasons: { about: "group" | "type"; reason: string; confidence: "low" | "medium" | "high" }[];
}

interface Place {
  widget: Widget;
  sectionId: string;
  sectionTitle: string;
  anchorId?: string;
  anchorText: string;
  label: string;
}

const ROUTE = /\s*[>.,:\-–—]*\s*go to (section|question)\s+(\d+[a-z]?(?:\.\d+)*)\.?\s*$/i;
const DATE_WORD = /^(day|month|year|dd|mm|yyyy)$/i;
const ANCHOR = /^(\d{1,2}(?:\.\d{1,2})+|\d{1,2}(?=\.\s))\.?\s+(\S.*)$/;
const SECTION = /^Section\s+(\d+[a-z]?)\b[\s:–—.-]*(.*)$/i;
/** A checkbox further than this (top to top) from the previous one starts a new group. */
const GROUP_GAP = 60;
const ROW_TOLERANCE = 4;
const LABEL_REACH = 45;
const CONTINUATION_GAP = 17;

function top(w: Widget): number {
  return w.rect[3];
}

function readingOrder(a: Widget, b: Widget): number {
  return a.page - b.page || top(b) - top(a) || a.rect[0] - b.rect[0];
}

function onRow(line: Line, w: Widget): boolean {
  return line.page === w.page && line.y >= w.rect[1] - ROW_TOLERANCE && line.y <= w.rect[3] + ROW_TOLERANCE;
}

/** The text beside a box: to its right for a checkbox, to its left for a text box. */
function labelBeside(w: Widget, lines: Line[]): string | undefined {
  const beside = lines.filter(
    (l) => onRow(l, w) && (w.kind === "text" ? l.x1 <= w.rect[0] + 2 && w.rect[0] - l.x1 < 60 : l.x0 >= w.rect[2] - 2 && l.x0 - w.rect[2] < 40)
  );
  const nearest = (w.kind === "text" ? beside.sort((a, b) => b.x1 - a.x1) : beside.sort((a, b) => a.x0 - b.x0))[0];
  if (!nearest) {
    return undefined;
  }
  if (w.kind === "text") {
    return nearest.text;
  }
  const rest = lines.filter(
    (l) => l.page === w.page && Math.abs(l.x0 - nearest.x0) <= 3 && l.y < nearest.y && nearest.y - l.y <= CONTINUATION_GAP && !ANCHOR.test(l.text)
  );
  return /[.?:)]$/.test(nearest.text) || !rest[0] ? nearest.text : `${nearest.text} ${rest[0].text}`;
}

/** The lines directly above a box, nearest last, up to the anchor that opens the question. */
function labelAbove(w: Widget, lines: Line[]): string | undefined {
  const above = lines
    .filter((l) => l.page === w.page && l.y >= w.rect[3] - 2 && l.y - w.rect[3] <= LABEL_REACH && l.x0 < w.rect[2] && l.x1 > w.rect[0] - 2)
    .sort((a, b) => a.y - b.y);
  const first = above[0];
  if (!first) {
    return undefined;
  }
  const taken = [first];
  for (const l of lines.filter((c) => c.page === w.page && c.x0 < w.rect[2]).sort((a, b) => a.y - b.y)) {
    const last = taken.at(-1);
    if (
      last &&
      l.y > last.y &&
      l.y - last.y <= CONTINUATION_GAP &&
      taken.length < 3 &&
      !ANCHOR.test(last.text) &&
      (Math.abs(l.x0 - first.x0) <= 3 || ANCHOR.test(l.text))
    ) {
      taken.push(l);
    }
  }
  return taken
    .reverse()
    .map((l) => l.text)
    .join(" ");
}

function stripAnchor(text: string): string {
  return ANCHOR.exec(text)?.[2] ?? text;
}

/** A bracketed second line under a section heading, such as "(the sole applicant or applicant 1)". */
function subtitleOf(heading: Line, lines: Line[]): string {
  return lines.find((l) => l.page === heading.page && l.y < heading.y && heading.y - l.y <= 25 && l.text.startsWith("("))?.text ?? "";
}

function choiceOf(label: string, slot: number, ticked: boolean): Choice {
  const m = ROUTE.exec(label);
  if (!m) {
    return { label, slot, ticked };
  }
  const kind = (m[1] ?? "").toLowerCase() === "section" ? "section" : "question";
  return { label: label.slice(0, m.index).trim(), slot, ticked, route: { kind, id: m[2] ?? "", text: m[0].replace(/^[\s>.,:\-–—]+/, "").trim() } };
}

/** How far below an undotted number a box may start for the number to be a question's rather than numbered guidance. */
const NUMBERED_REACH = 60;

/** A section heading, or a numbered question: a dotted id such as 2.1 always is, an undotted "3." only when a box is just below it. */
function isMarker(line: Line, widgets: Widget[]): boolean {
  if (SECTION.test(line.text)) {
    return true;
  }
  const id = ANCHOR.exec(line.text)?.[1];
  return id !== undefined && (id.includes(".") || widgets.some((w) => w.page === line.page && w.rect[3] <= line.y + 2 && line.y - w.rect[3] <= NUMBERED_REACH));
}

/** The top of a question line, raised to the top of any box on the same row so that the question comes before it. */
function rowTop(line: Line, widgets: Widget[]): number {
  const row = widgets.filter((w) => w.page === line.page && w.rect[1] <= line.y && line.y <= w.rect[3]).map(top);
  return Math.max(line.y + line.height, ...row);
}

/** Walks the page text and fields in reading order, giving each field the section and question it sits under. */
function place(content: PdfContent): Place[] {
  type Event = { page: number; y: number; order: number; line?: Line; widget?: Widget };
  const events: Event[] = [
    ...content.lines.filter((l) => isMarker(l, content.widgets)).map((line) => ({ page: line.page, y: rowTop(line, content.widgets), order: 0, line })),
    ...content.widgets.map((widget) => ({ page: widget.page, y: top(widget), order: 1, widget }))
  ];
  events.sort((a, b) => a.page - b.page || b.y - a.y || a.order - b.order || (a.widget?.rect[0] ?? 0) - (b.widget?.rect[0] ?? 0));
  // Fields above the first heading are a section of their own, so they do not take the title of section 1.
  let section = { id: "0", title: "" };
  let anchor: { id: string; text: string } | undefined;
  const placed: Place[] = [];
  for (const e of events) {
    const heading = e.line ? SECTION.exec(e.line.text) : null;
    const question = e.line ? ANCHOR.exec(e.line.text) : null;
    if (heading && e.line) {
      section = { id: heading[1] ?? "1", title: [e.line.text, subtitleOf(e.line, content.lines)].join(" ").trim() };
      anchor = undefined;
    } else if (question && e.line) {
      anchor = { id: question[1] ?? "", text: question[2] ?? "" };
    } else if (e.widget) {
      const w = e.widget;
      const raw = labelBeside(w, content.lines) ?? labelAbove(w, content.lines) ?? "";
      placed.push({
        widget: w,
        sectionId: section.id,
        sectionTitle: section.title,
        ...(anchor ? { anchorId: anchor.id } : {}),
        anchorText: anchor?.text ?? "",
        label: stripAnchor(raw)
      });
    }
  }
  return placed;
}

/** Members of the set of checkboxes that continues from places[start]: the same numbered question, or with no number, close together; no text box between. */
function checkboxRun(places: Place[], start: number): Place[] {
  const run = [places[start] as Place];
  for (let j = start + 1; j < places.length; j++) {
    const p = places[j] as Place;
    const prev = run.at(-1) as Place;
    const sameQuestion = p.anchorId !== undefined && p.anchorId === prev.anchorId;
    const joins =
      p.widget.kind === "checkbox" &&
      p.sectionId === prev.sectionId &&
      p.widget.page === prev.widget.page &&
      (sameQuestion || (p.anchorId === prev.anchorId && top(prev.widget) - top(p.widget) <= GROUP_GAP));
    if (!joins) {
      break;
    }
    run.push(p);
  }
  return run;
}

/** Boxes below a text box with the same left edge and no label of their own are further rows of the same answer. */
function textRows(places: Place[], start: number): Place[] {
  const rows = [places[start] as Place];
  for (let j = start + 1; j < places.length; j++) {
    const p = places[j] as Place;
    const prev = rows.at(-1) as Place;
    const below =
      p.widget.kind === "text" &&
      p.anchorId === prev.anchorId &&
      p.widget.page === prev.widget.page &&
      Math.abs(p.widget.rect[0] - prev.widget.rect[0]) <= 2 &&
      prev.widget.rect[1] - p.widget.rect[3] <= CONTINUATION_GAP * 2 &&
      (p.label === "" || p.label === prev.label);
    if (!below) {
      break;
    }
    rows.push(p);
  }
  return rows;
}

/** Day, month and year boxes in one row, in that order, are one date. */
function dateRun(places: Place[], start: number): Place[] | undefined {
  const run = places.slice(start, start + 3);
  const [d, m, y] = run.map((p) => p.label.toLowerCase());
  const row =
    run.length === 3 &&
    run.every((p) => p.widget.kind === "text" && p.widget.page === run[0]?.widget.page && Math.abs(p.widget.rect[1] - (run[0]?.widget.rect[1] ?? 0)) <= 2);
  return row && /^(day|dd)$/.test(d ?? "") && /^(month|mm)$/.test(m ?? "") && /^(year|yyyy)$/.test(y ?? "") ? run : undefined;
}

/**
 * One draft field per question: a checkbox set or radio group becomes an XoR group, day/month/year boxes one date, anything else one text field.
 * A text box between two checkboxes ends the group.
 */
export function draftFields(content: PdfContent): DraftField[] {
  const places = place(content).sort((a, b) => readingOrder(a.widget, b.widget));
  const drafts: DraftField[] = [];
  const idsSeen = new Set<string>();
  const consumed = new Set<Place>();
  const idFor = (p: Place): string | undefined => {
    if (!p.anchorId || idsSeen.has(p.anchorId)) {
      return undefined;
    }
    idsSeen.add(p.anchorId);
    return p.anchorId;
  };
  places.forEach((first, index) => {
    if (consumed.has(first)) {
      return;
    }
    const base = { page: first.widget.page, sectionId: first.sectionId, sectionTitle: first.sectionTitle, question: first.anchorText };
    const id = idFor(first);
    const common = { ...(id ? { id } : {}), role: "field" as const, mandatory: "mandatory" as const, ccd: [], todo: [], rules: [] };
    if (first.widget.kind === "text") {
      const date = dateRun(places, index);
      const rows = date ? [first] : textRows(places, index);
      for (const p of [...(date ?? []), ...rows]) {
        consumed.add(p);
      }
      const label = date
        ? stripAnchor(
            labelAbove(
              first.widget,
              content.lines.filter((l) => !DATE_WORD.test(l.text))
            ) ?? "Date"
          )
        : first.label || first.widget.tooltip || first.widget.name;
      const lengths = rows.map((p) => p.widget.maxLength);
      const maxLength = lengths.every((n) => n !== undefined) ? lengths.reduce((sum: number, n) => sum + (n ?? 0), 0) : undefined;
      const note = id && !date ? noteFor(id, content.lines, first.widget.page) : undefined;
      drafts.push({
        ...base,
        ...(note ? { note } : {}),
        slotLabels: date ? date.map((p) => `${label} ${p.label}`) : [label],
        reasons: date ? [{ about: "type", reason: "three boxes labelled day, month and year", confidence: "medium" }] : [],
        field: {
          ...common,
          label,
          inputType: date ? "date" : "text",
          keys: date ? ["", "", ""] : [""],
          ...(!date && maxLength ? { maxLength } : {})
        }
      });
      return;
    }
    const radio = first.widget.kind === "radio";
    const members = radio ? places.filter((p) => p.widget.kind === "radio" && p.widget.name === first.widget.name) : checkboxRun(places, index);
    for (const p of members) {
      consumed.add(p);
    }
    const question = stripAnchor(labelAbove(first.widget, content.lines) ?? "") || first.anchorText || first.label || first.widget.tooltip || first.widget.name;
    const yesNo = members.length === 2 && /^yes\b/i.test(members[0]?.label ?? "") && /^no\b/i.test(members[1]?.label ?? "");
    const choices = members.map((p, n) => choiceOf(p.label, yesNo ? 0 : n, !yesNo || n === 0));
    drafts.push({
      ...base,
      question,
      choices,
      slotLabels: yesNo ? [question] : choices.map((c) => c.label),
      reasons:
        members.length < 2
          ? []
          : [
              {
                about: "group",
                reason: radio ? "buttons of one radio group in the PDF" : `${members.length} checkboxes under one question`,
                confidence: radio ? "high" : "medium"
              }
            ],
      field: { ...common, label: question, inputType: "checkbox", keys: yesNo ? [""] : members.map(() => "") },
      groupSize: members.length
    });
  });
  return drafts;
}
