"use client";

import { type ReactNode, useId, useState } from "react";
import { FIELD } from "@/components/assistant/WelshParts";

/** The pieces the Bulk Scan editor's panes share: icon buttons, cards and labelled inputs. */

export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-asst-accent";
export const SMALL_BUTTON = `rounded-lg border border-asst-line px-2.5 py-1 text-xs font-medium text-asst-text hover:bg-asst-hover disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
export const INPUT = `${FIELD} min-w-0 ${FOCUS}`;

const PATHS = {
  up: "M5 12.5 10 7.5l5 5",
  down: "M5 7.5l5 5 5-5",
  remove: "M5.5 5.5l9 9M14.5 5.5l-9 9",
  plus: "M10 4.5v11M4.5 10h11",
  check: "M4.5 10.5l3.5 3.5 7.5-8",
  caret: "M7 5l6 5-6 5",
  search: "M9 15.5a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13Zm5-1.5 3.5 3.5",
  review: "M5 17V3.5M5 4h9l-2 3.5 2 3.5H5",
  todo: "M4 5.5l1.5 1.5L8 4.5M4 11.5 5.5 13 8 10.5M11 5.5h5M11 11.5h5",
  english: "M3.5 5.5h13M3.5 10h8M3.5 14.5h13",
  unsure: "M7.5 7.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M10 15v.5",
  error: "M10 6v5M10 14v.5M10 2.5l8 14H2l8-14Z"
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "h-4 w-4" }: Readonly<{ name: IconName; className?: string }>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** An icon-only button that is named, and shows its name as a tooltip, by `label`. */
export function IconButton({ label, icon, disabled, onClick }: Readonly<{ label: string; icon: IconName; disabled?: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-asst-line text-asst-text hover:bg-asst-hover disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
    >
      <Icon name={icon} />
    </button>
  );
}

/** A button with a small icon and a visible name, for adding a row to a list. */
export function AddButton({
  label,
  text,
  disabled,
  title,
  onClick
}: Readonly<{ label: string; text: string; disabled?: boolean; title?: string; onClick: () => void }>) {
  return (
    <button type="button" aria-label={label} title={title} disabled={disabled} onClick={onClick} className={`${SMALL_BUTTON} inline-flex items-center gap-1`}>
      <Icon name="plus" className="h-3.5 w-3.5" />
      {text}
    </button>
  );
}

/** A titled card; the title names the region for a screen reader. */
export function Card({ title, children, hint }: Readonly<{ title: string; children: ReactNode; hint?: string }>) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border border-asst-line bg-asst-panel p-4">
      <div className="flex flex-col gap-0.5">
        <h3 id={id} className="text-sm font-semibold text-asst-text">
          {title}
        </h3>
        {hint ? <p className="text-xs text-asst-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** A visible label above its own input, which is the one child. */
export function Labelled({ label, children, className = "" }: Readonly<{ label: string; children: ReactNode; className?: string }>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the child, which only the caller knows
    <label className={`flex min-w-0 flex-col gap-1 text-xs font-medium text-asst-muted ${className}`}>
      {label}
      {children}
    </label>
  );
}

/**
 * A text box that keeps what is typed and sends it only when the person leaves the box or presses Enter, so a key that
 * is half retyped is never taken for a new key. A change from outside, such as a row that moved here, replaces the text.
 */
export function CommitInput({
  label,
  value,
  placeholder,
  normalise = (text) => text,
  keepValue = false,
  onCommit
}: Readonly<{
  label: string;
  value: string;
  placeholder?: string;
  /** What the text means, so that text which says the same thing as the value is no change. */
  normalise?: (text: string) => string;
  /** Whether a cleared box goes back to its value rather than being sent as empty. */
  keepValue?: boolean;
  onCommit: (text: string) => void;
}>) {
  const [state, setState] = useState({ base: value, text: value });
  if (state.base !== value) {
    setState({ base: value, text: value });
  }
  const commit = () => {
    const meant = normalise(state.text);
    if (meant === normalise(value)) {
      return;
    }
    if (keepValue && meant === "") {
      setState({ base: value, text: value });
      return;
    }
    onCommit(state.text);
  };
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      value={state.text}
      className={INPUT}
      onChange={(e) => setState({ base: state.base, text: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
        }
      }}
    />
  );
}
