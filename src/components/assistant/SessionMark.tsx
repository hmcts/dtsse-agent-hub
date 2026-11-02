import type { ReactNode } from "react";

/**
 * The mark `LocalMark` and `PodMark` both draw: an icon in the session's colour, the words for a screen reader, and the
 * tooltip.
 *
 * A working session carries a filled green badge on the icon's top-right corner. The icons are outlines, so the badge
 * is how working differs from ready by shape rather than by colour alone, and it stays when the pulse on it has
 * stopped or never started for reduced motion. It is absolutely placed, so the row is laid out the same with or
 * without it, and hidden from screen readers, because the words already say the state.
 */
export function SessionMark({ words, colour, working, icon }: { words: string; colour: string; working: boolean; icon: ReactNode }) {
  return (
    <span className={`relative flex shrink-0 items-center ${colour}`} title={words}>
      {icon}
      {working ? (
        <span aria-hidden="true" data-badge="working" className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-asst-ok status-pulse" />
      ) : null}
      {/* The trailing space is part of the text: the name of the row this sits in is these words joined to its
          title, and nothing between two inline elements adds one. */}
      <span className="sr-only">{`${words}: `}</span>
    </span>
  );
}
