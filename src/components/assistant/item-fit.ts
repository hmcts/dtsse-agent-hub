/** Which of a row's items show as buttons, and which go in the overflow menu; both as indexes into the items. */
export interface ItemFit {
  shown: number[];
  hidden: number[];
}

/**
 * Fits as many items as the row has room for, in order. When some must go in the overflow menu the room is what is
 * left after its button, and the open item takes the place of the last one that fits, so it never leaves the row.
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
  if (current >= count && shown.length > 0) {
    shown[shown.length - 1] = current;
  }
  return { shown, hidden: all.filter((index) => !shown.includes(index)) };
}
