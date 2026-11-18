"use client";

import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";

/**
 * Everything in a dialog a Tab can reach, and so everything its focus trap has to account for.
 *
 * `tabindex="-1"` is excluded from every clause, not only the last, so that what this matches is what Tab can reach: a
 * roving tabindex leaves all but one of its buttons deliberately out of the tab order. A hidden input is left out for
 * the same reason: Tab never lands on one, and a form posting a hidden field would otherwise be counted as a stop.
 */
export const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]"
]
  .map((selector) => `${selector}:not([tabindex="-1"])`)
  .join(", ");

/**
 * Keeps Tab inside `panel`: off either end it wraps to the other, so it never reaches the page behind a modal. Escape
 * is answered by `onEscape`, and goes no further, since the shell closes its drawer on an Escape that reaches `window`
 * and a dialog over it should dismiss only itself. Listening on `document` is what lets a control inside answer
 * Escape first: a combobox shutting its list stops the event before it gets here.
 */
export function useModalKeys(panel: RefObject<HTMLElement | null>, onEscape: () => void): void {
  const answer = useRef(onEscape);
  answer.current = onEscape;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        answer.current();
        return;
      }
      const items = event.key === "Tab" ? [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])] : [];
      if (items.length === 0) {
        return;
      }
      const edge = event.shiftKey ? items[0] : items.at(-1);
      if (document.activeElement === edge || !panel.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) : items[0])?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);
}

/**
 * A dialog over the Assistant: a backdrop that closes it, a title with a × beside it, focus kept inside while it is
 * open, and given back on close to whatever had it before, which is the control that opened it. `initialFocus` is
 * where focus goes as it opens; without it, the first thing in the dialog Tab can reach.
 *
 * The frame only: what the dialog asks and how it is saved are its body's.
 */
export function AssistantModal({
  title,
  onClose,
  initialFocus,
  closeLabel = "Close",
  className = "",
  children
}: {
  title: ReactNode;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  /** The × and the backdrop's accessible name: "Close" unless the dialog has a better word for it. */
  closeLabel?: string;
  /** Sizes the panel; the frame sets only what every dialog shares. */
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useModalKeys(panel, onClose);

  // biome-ignore lint/correctness/useExhaustiveDependencies: where focus goes is decided once, as the dialog opens
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = initialFocus?.current ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current;
    first?.focus();
    return () => {
      // Only to an element still on the page: one the close removed would drop focus to the body.
      if (before?.isConnected === true) {
        before.focus();
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-5">
      {/* Out of the tab order: the × is the keyboard's way out, and a second close button would be a stop for nothing. */}
      <button type="button" tabIndex={-1} aria-label={closeLabel} onClick={onClose} className="absolute inset-0 cursor-default bg-black/60" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative flex max-h-full w-full flex-col gap-4 overflow-y-auto rounded-2xl border border-asst-line bg-asst-hover p-[22px] shadow-2xl outline-hidden ${className}`}
      >
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="flex-1 text-lg font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="-mr-1.5 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-asst-muted hover:bg-asst-active hover:text-asst-text"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ×
            </span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
