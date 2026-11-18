"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Dot, ItemSwitcher, itemState, type SwitcherItem } from "@/components/assistant/ItemSwitcher";
import { fitItems } from "@/components/assistant/item-fit";

const GAP = 6;
// The overflow button's width, assumed rather than measured because it is only drawn once something overflows.
const OVERFLOW_WIDTH = 96;

const BUTTON =
  "flex h-[34px] max-w-[11rem] shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] border px-2.5 text-[13px] hover:border-asst-accent-line hover:bg-asst-field";

function ItemButton({ item, current, testIds }: Readonly<{ item: SwitcherItem; current: boolean; testIds: boolean }>) {
  const marked = itemState(item);
  const look = current
    ? "border-asst-accent-line bg-asst-active text-asst-accent-soft"
    : marked === null
      ? "border-asst-strong"
      : "border-asst-accent bg-asst-field";
  return (
    <button
      type="button"
      aria-label={marked === null ? item.label : `${item.label}, ${marked.suffix}`}
      aria-current={current ? "true" : undefined}
      onClick={item.open}
      className={`${BUTTON} ${look}`}
    >
      <span className="min-w-0 truncate">{item.label}</span>
      {marked === null ? null : <Dot testId={testIds ? marked.testId : undefined} />}
    </button>
  );
}

/**
 * The header row of a conversation's items, each a button of its own. The items there is no room for, measured
 * against the row's width, go in a "+N more" menu; the open item always keeps its button.
 *
 * Each item is drawn a second time, invisibly, so its width is known whether or not it is showing. The widths are read
 * after every render and the room whenever the row is resized, and the split is worked out from both.
 */
export function ItemButtons({ items, current }: Readonly<{ items: readonly SwitcherItem[]; current: string | null }>) {
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [widths, setWidths] = useState<number[]>([]);

  const read = useCallback(() => {
    setAvailable(row.current?.clientWidth ?? 0);
    const next = Array.from(measure.current?.children ?? [], (child) => (child as HTMLElement).offsetWidth);
    setWidths((previous) => (previous.length === next.length && previous.every((width, at) => width === next[at]) ? previous : next));
  }, []);

  // No dependencies: a label or a mark changes a button's width without changing the row's.
  useLayoutEffect(read);

  useLayoutEffect(() => {
    const node = row.current;
    if (node === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [read]);

  const fit = fitItems({
    widths: widths.length === items.length ? widths : items.map(() => 0),
    // A row with no width has not been laid out (or is not displayed), so there is nothing to fit against yet.
    available: available > 0 ? available : Number.POSITIVE_INFINITY,
    overflowWidth: OVERFLOW_WIDTH,
    gap: GAP,
    current: items.findIndex((item) => item.key === current)
  });
  const hidden = fit.hidden.map((index) => items[index]).filter((item): item is SwitcherItem => item !== undefined);
  return (
    <div ref={row} role="group" aria-label="Items" className="relative flex min-w-0 flex-1 basis-0 items-center justify-end gap-1.5">
      <div ref={measure} aria-hidden="true" inert className="pointer-events-none invisible absolute flex h-0 gap-1.5 overflow-hidden">
        {items.map((item) => (
          <ItemButton key={item.key} item={item} current={item.key === current} testIds={false} />
        ))}
      </div>
      {fit.shown.map((index) => {
        const item = items[index];
        return item === undefined ? null : <ItemButton key={item.key} item={item} current={item.key === current} testIds />;
      })}
      {hidden.length === 0 ? null : <ItemSwitcher items={hidden} current={current} />}
    </div>
  );
}
