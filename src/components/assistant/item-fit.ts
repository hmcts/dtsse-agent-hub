/** Which of a row's items show as buttons, and which go in the overflow menu; both as indexes into the items. */
export interface ItemFit {
  shown: number[];
  hidden: number[];
}

/**
 * Fits as many items as the row has room for, in order. When some must go in the overflow menu the room is what is
 * left after its button, and the open item always keeps its button, displacing the last items shown until it fits, and stays even when it is the only
 * one and does not fit.
 * Nothing is hidden when every item fits without the overflow button; widths are measured, so a row not yet measured
 * (no widths for the items) shows them all.
 */
export function fitItems(input: { widths: readonly number[]; available: number; overflowWidth: number; gap: number; current: number }): ItemFit {
  const { widths, available, overflowWidth, gap, current } = input;
  const all = widths.map((_, index) => index);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) {
    return { shown: all, hidden: [] };
  }
  const room = available - overflowWidth - gap;
  let used = 0;
  let count = 0;
  while (count < widths.length && used + (widths[count] ?? 0) + (count > 0 ? gap : 0) <= room) {
    used += (widths[count] ?? 0) + (count > 0 ? gap : 0);
    count += 1;
  }
  const shown = all.slice(0, count);
  if (current >= count) {
    const wanted = widths[current] ?? 0;
    const usedBy = (indexes: number[]) => indexes.reduce((sum, index, at) => sum + (widths[index] ?? 0) + (at > 0 ? gap : 0), 0);
    while (shown.length > 0 && usedBy(shown) + gap + wanted > room) {
      shown.pop();
    }
    shown.push(current);
  }
  return { shown, hidden: all.filter((index) => !shown.includes(index)) };
}
