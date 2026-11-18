"use client";

import { useEffect } from "react";
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
function state(item: SwitcherItem): { suffix: string; testId: string } | null {
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
function Dot({ testId }: { testId?: string }) {
  return <span aria-hidden="true" data-testid={testId} className="h-1.5 w-1.5 shrink-0 rounded-full bg-asst-accent" />;
}

/**
 * Moves between the items a conversation holds — its document, slides and templates — one panel at a time. The
 * trigger names the open item, and carries a dot while any item has something the person has not seen. Nothing is
 * shown while the conversation holds no item: Create is how the first one is made.
 *
 * Below 480px the trigger is its icon alone, so a 320px header still fits the title, the product chip and the menus.
 */
export function ItemSwitcher({ items, current }: Readonly<{ items: readonly SwitcherItem[]; current: string | null }>) {
  const menu = useMenuButton();
  const empty = items.length === 0;
  const { close } = menu;
  // Unmounting the menu with the list would leave it open, to come back open with the next item.
  useEffect(() => {
    if (empty) {
      close();
    }
  }, [empty, close]);
  if (empty) {
    return null;
  }
  const shown = items.find((item) => item.key === current);
  const attention = items.some((item) => state(item) !== null);
  const name = shown === undefined ? "Items" : `Items, ${shown.label} open`;
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
        className={`flex h-[34px] items-center whitespace-nowrap rounded-[9px] border px-2.5 text-[13px] hover:border-asst-accent-line hover:bg-asst-field min-[480px]:gap-2 min-[480px]:pr-3 ${attention ? "border-asst-accent bg-asst-field" : "border-asst-strong"}`}
      >
        <span aria-hidden="true" className="text-sm leading-none text-asst-accent">
          ▤
        </span>
        <span className="hidden max-w-[10rem] truncate min-[480px]:inline">{shown?.label ?? "Items"}</span>
        <span aria-hidden="true" className="hidden text-[7px] leading-none text-asst-accent min-[480px]:inline">
          ▼
        </span>
        {attention ? <Dot /> : null}
      </button>
      {menu.open ? (
        <div
          ref={menu.menu}
          role="menu"
          aria-label="Items"
          onKeyDown={menu.onMenuKeyDown}
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex w-[220px] flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl"
        >
          {items.map((item) => {
            const marked = state(item);
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
