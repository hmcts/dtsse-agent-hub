"use client";

import { useMenuButton } from "@/components/assistant/useMenuButton";

/** One kind of item Create offers. */
export interface CreateOption {
  key: string;
  label: string;
  /** The conversation already holds one, which it can hold only one of, so choosing it opens that one. */
  exists?: boolean;
  choose: () => void;
}

/**
 * The chat header's Create menu: each kind of item a conversation can hold, made or, where the conversation already
 * holds that kind, opened. Below 480px the trigger is its icon alone, as the switcher's is.
 */
export function CreateMenu({ options }: Readonly<{ options: readonly CreateOption[] }>) {
  const menu = useMenuButton();
  return (
    <div ref={menu.container} className="relative flex shrink-0">
      <button
        ref={menu.trigger}
        type="button"
        aria-label="Create"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        className="flex h-[34px] items-center whitespace-nowrap rounded-[9px] border border-asst-strong px-2.5 text-[13px] hover:border-asst-accent-line hover:bg-asst-field min-[480px]:gap-2 min-[480px]:pr-3"
      >
        <span aria-hidden="true" className="text-lg leading-none text-asst-accent">
          +
        </span>
        <span className="hidden min-[480px]:inline">Create</span>
      </button>
      {menu.open ? (
        <div
          ref={menu.menu}
          role="menu"
          aria-label="Create"
          onKeyDown={menu.onMenuKeyDown}
          className="absolute right-0 top-[calc(100%+6px)] z-30 flex w-[220px] flex-col gap-0.5 rounded-xl border border-asst-strong bg-asst-hover p-1.5 shadow-2xl"
        >
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitem"
              aria-label={option.exists === true ? `${option.label}, already in this chat` : option.label}
              tabIndex={-1}
              onClick={() => {
                menu.close();
                option.choose();
              }}
              className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-asst-active focus:bg-asst-active focus:outline-hidden"
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.exists === true ? (
                <span aria-hidden="true" className="text-xs text-asst-faint">
                  Open
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
