"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Dot, ItemSwitcher, itemState, MoreLabel, moreButtonClass, type SwitcherItem } from "@/components/assistant/ItemSwitcher";
import { fitItems } from "@/components/assistant/item-fit";

const GAP = 6;

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
 * Each item, and one "+N more" button at its widest, is drawn a second time, invisibly, so their widths are known
 * whether or not they are showing. They are read when the row or any of them changes size, which takes in web fonts
 * loading and zoom, and when the labels or marks change; the split is worked out from them.
 */
export function ItemButtons({ items, current }: Readonly<{ items: readonly SwitcherItem[]; current: string | null }>) {
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  // Null until measured, when everything shows; a measured 0 is a row with no room.
  const [available, setAvailable] = useState<number | null>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const key = items.map((item) => `${item.label}\u0000${itemState(item)?.suffix ?? ""}`).join("\u0001");

  const read = useCallback(() => {
    setAvailable(Math.floor(row.current?.getBoundingClientRect().width ?? 0));
    const next = Array.from(measure.current?.children ?? [], (child) => Math.ceil(child.getBoundingClientRect().width));
    setWidths((previous) => (previous.length === next.length && previous.every((width, at) => width === next[at]) ? previous : next));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the labels and marks, which change the measured buttons.
  useLayoutEffect(() => {
    read();
    if (row.current === null || measure.current === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(read);
    observer.observe(row.current);
    observer.observe(measure.current);
    for (const child of Array.from(measure.current.children)) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [read, key]);

  const complete = widths.length === items.length + 1;
  // The room every item would need, so the title, which shrinks far faster, gives way before the items do.
  const wanted = complete && items.length > 0 ? widths.slice(0, items.length).reduce((sum, width) => sum + width, 0) + GAP * (items.length - 1) : null;
  const fit = fitItems({
    widths: complete ? widths.slice(0, items.length) : items.map(() => 0),
    available: available ?? Number.POSITIVE_INFINITY,
    overflowWidth: complete ? (widths[items.length] ?? 0) : 0,
    gap: GAP,
    current: items.findIndex((item) => item.key === current)
  });
  const hidden = fit.hidden.map((index) => items[index]).filter((item): item is SwitcherItem => item !== undefined);
  return (
    <div
      ref={row}
      role="group"
      aria-label="Items"
      style={wanted === null ? undefined : { flexBasis: wanted }}
      className="relative flex min-w-0 shrink grow basis-auto items-center justify-end gap-1.5"
    >
      <div ref={measure} aria-hidden="true" inert className="pointer-events-none invisible absolute flex h-0 gap-1.5 overflow-hidden">
        {items.map((item) => (
          <ItemButton key={item.key} item={item} current={item.key === current} testIds={false} />
        ))}
        <div className={moreButtonClass(true)}>
          <MoreLabel count={99} attention />
        </div>
      </div>
      {fit.shown.map((index) => {
        const item = items[index];
        return item === undefined ? null : <ItemButton key={item.key} item={item} current={item.key === current} testIds />;
      })}
      {hidden.length === 0 ? null : <ItemSwitcher items={hidden} current={current} />}
    </div>
  );
}
