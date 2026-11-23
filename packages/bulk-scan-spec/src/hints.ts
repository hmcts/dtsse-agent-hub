import type { Line } from "./pdf-extract.ts";

/** The margin note a form prints beside question `id` ("Note 1.1" and the lines under it), joined into one sentence. */
export function noteFor(id: string, lines: Line[]): string | undefined {
  const head = lines.find((l) => l.text === `Note ${id}`);
  if (!head) {
    return undefined;
  }
  const taken: Line[] = [];
  for (const l of lines.filter((c) => c.page === head.page && c.y < head.y && Math.abs(c.x0 - head.x0) <= 3).sort((a, b) => b.y - a.y)) {
    if ((taken.at(-1)?.y ?? head.y) - l.y > 20) {
      break;
    }
    taken.push(l);
  }
  return taken.length > 0 ? taken.map((l) => l.text).join(" ") : undefined;
}

export interface HintedFormat {
  regex: string;
  /** The sentence the regex was read from. */
  source: string;
}

const STARTS_WITH_LETTERS = /\bbegins? with the letters? ([A-Z])(?: or ([A-Z]))?\b/i;

/** The format a note states: "begin with the letter X or G" is the only wording the real forms use. */
export function formatFromNote(note: string): HintedFormat | undefined {
  const m = STARTS_WITH_LETTERS.exec(note);
  if (!m?.[1]) {
    return undefined;
  }
  const letters = [m[1], m[2]].filter((c): c is string => c !== undefined).map((c) => c.toUpperCase());
  const start = /[^.]*\bbegins? with the letters?[^.]*\./i.exec(note)?.[0].trim() ?? m[0];
  return { regex: `^[${letters.join("")}].*`, source: start };
}
