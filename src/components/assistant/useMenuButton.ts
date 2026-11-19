"use client";

import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useDismiss } from "@/components/assistant/useDismiss";

/**
 * A menu button's keyboard and focus behaviour, as the chat header's menus share it: the trigger opens the menu on a
 * press or on an arrow key and focus moves into it, the arrows, Home and End move between its items, Tab leaves it
 * closed, and Escape or a click outside dismisses it as `useDismiss` does every other menu here.
 */
/**
 * Which item a menu's key moves focus to: up and down wrap at either end, Home and End go to them, and anything else
 * is not the menu's. `at` is the focused item's place, or -1 for none, when either arrow starts from its own end.
 */
export function menuKeyTarget(key: string, at: number, count: number): number | null {
  if (count === 0) {
    return null;
  }
  switch (key) {
    case "ArrowDown":
      return (at + 1) % count;
    case "ArrowUp":
      return at <= 0 ? count - 1 : at - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Moves focus among a menu's items for a key it answers, which it then takes. */
export function moveFocusInMenu(event: { key: string; preventDefault: () => void }, items: readonly HTMLElement[]): void {
  const next = menuKeyTarget(event.key, items.indexOf(document.activeElement as HTMLElement), items.length);
  if (next !== null) {
    event.preventDefault();
    items[next]?.focus();
  }
}

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
    moveFocusInMenu(event, items());
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
