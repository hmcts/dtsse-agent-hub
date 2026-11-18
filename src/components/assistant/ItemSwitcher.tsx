"use client";

import { useMenuButton } from "@/components/assistant/useMenuButton";

/** One thing a conversation holds that opens in the panel beside it. */
export interface SwitcherItem {
  key: string;
  label: string;
  open: () => void;
  /** The assistant changed it while another panel was busy, so it waits to be opened. */
  waiting?: boolean;
  /** An edit the person closed it on could not be saved, and waits to be opened again. */
  unsaved?: boolean;
  /** A load into it failed while it was closed, and the reason waits in it. */
  failed?: boolean;
}

/** What is said and marked for an item with something to see; unsaved changes first, as the person's own work. */
export function itemState(item: SwitcherItem): { suffix: string; testId: string } | null {
  if (item.unsaved === true) {
    return { suffix: "with your unsaved changes", testId: `${item.key}-unsaved` };
  }
  if (item.failed === true) {
    return { suffix: "which did not load", testId: `${item.key}-failed` };
  }
  if (item.waiting === true) {
    return { suffix: "updated by the assistant", testId: `${item.key}-updated` };
  }
  return null;
}

/** Marked by a shape as well as the border's colour, so the change is not told by colour alone. */
export function Dot({ testId }: { testId?: string }) {
  return <span aria-hidden="true" data-testid={testId} className="h-1.5 w-1.5 shrink-0 rounded-full bg-asst-accent" />;
}

/**
 * The menu behind a header row's "+N more" button, listing the items there was no room for. The button carries a dot
 * while any of them has something the person has not seen.
 *
 * Below 480px the button is "+N" and its icon, so a 320px header still fits the title, the product chip and the menus.
 */
export function ItemSwitcher({ items, current }: Readonly<{ items: readonly SwitcherItem[]; current: string | null }>) {
  const menu = useMenuButton();
  const attention = items.some((item) => itemState(item) !== null);
  const name = `${items.length} more ${items.length === 1 ? "item" : "items"}`;
  return (
    <div ref={menu.container} className="relative flex shrink-0">
      <button
        ref={menu.trigger}
        type="button"
        aria-label={attention ? `${name}, with changes to see` : name}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        className={`flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-[9px] border px-2.5 text-[13px] hover:border-asst-accent-line hover:bg-asst-field ${attention ? "border-asst-accent bg-asst-field" : "border-asst-strong"}`}
      >
        <span aria-hidden="true" className="text-sm leading-none text-asst-accent">
          ▤
        </span>
        <span aria-hidden="true">
          +{items.length}
          <span className="hidden min-[480px]:inline"> more</span>
        </span>
        {attention ? <Dot /> : null}
      </button>
      {menu.open ? (
        <div
          ref={menu.menu}
          role="menu"
          aria-label="More items"
          onKeyDown={menu.onMenuKeyDown}
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex w-[220px] flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl"
        >
          {items.map((item) => {
            const marked = itemState(item);
            return (
              <button
                key={item.key}
                type="button"
                role="menuitemradio"
                aria-checked={item.key === current}
                aria-label={marked === null ? item.label : `${item.label}, ${marked.suffix}`}
                tabIndex={-1}
                onClick={() => {
                  menu.close();
                  item.open();
                }}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active focus:bg-asst-active focus:outline-hidden ${item.key === current ? "text-asst-accent-soft" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {marked === null ? null : <Dot testId={marked.testId} />}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
