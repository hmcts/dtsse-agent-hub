"use client";

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "@/components/assistant/useDismiss";

/**
 * A menu button's keyboard and focus behaviour, as the chat header's menus share it: the trigger opens the menu on a
 * press or on an arrow key and focus moves into it, the arrows, Home and End move between its items, Tab leaves it
 * closed, and Escape or a click outside dismisses it as `useDismiss` does every other menu here.
 */
export function useMenuButton() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Which end of the menu takes focus as it opens: ArrowUp on the trigger starts from the last item.
  const start = useRef<"first" | "last">("first");

  const close = useCallback(() => {
    if (container.current?.contains(document.activeElement)) {
      trigger.current?.focus();
    }
    setOpen(false);
  }, []);

  useDismiss(open, container, close);

  const items = useCallback(() => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []), []);

  useEffect(() => {
    if (open) {
      const all = items();
      (start.current === "last" ? all.at(-1) : all[0])?.focus();
    }
  }, [open, items]);

  function show(from: "first" | "last"): void {
    start.current = from;
    setOpen(true);
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show(event.key === "ArrowUp" ? "last" : "first");
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (at + 1) % all.length
        : event.key === "ArrowUp"
          ? (at - 1 + all.length) % all.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? all.length - 1
              : null;
    if (next !== null) {
      event.preventDefault();
      all[next]?.focus();
    }
  }

  return {
    open,
    close,
    container,
    trigger,
    menu,
    toggle: () => (open ? close() : show("first")),
    onTriggerKeyDown,
    onMenuKeyDown
  };
}
