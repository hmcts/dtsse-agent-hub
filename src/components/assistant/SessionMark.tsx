import type { ReactNode } from "react";

/**
 * The mark `LocalMark` and `PodMark` both draw: an icon in the session's colour, the words for a screen reader, and the
 * tooltip.
 *
 * A working session carries a filled badge on the icon's top-right corner, in the icon's own colour. The icons are
 * outlines, so the badge is how working differs from ready by shape rather than by colour alone, and it stays when the
 * pulse on it has stopped or never started for reduced motion. A rail-coloured edge parts it from the outline: on the
 * laptop it cuts the corner the badge sits over, so the badge reads as a dot of its own rather than a heavier corner.
 * The rows the mark sits in are on the rail unless hovered or selected, and on those the edge is a faint halo that
 * still parts the two. The edge is a span of its own so the pulse on the dot inside never fades it. The badge is
 * absolutely placed, so the row is laid out the same with or without it, and hidden from screen readers, because the
 * words already say the state.
 */
export function SessionMark({ words, colour, working, icon }: Readonly<{ words: string; colour: string; working: boolean; icon: ReactNode }>) {
  return (
    <span className={`relative flex shrink-0 items-center ${colour}`} title={words}>
      {icon}
      {working ? (
        <span aria-hidden="true" className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-asst-rail bg-asst-rail">
          <span data-badge="working" className="block h-full w-full rounded-full bg-current status-pulse" />
        </span>
      ) : null}
      {/* The trailing space is part of the text: the name of the row this sits in is these words joined to its
          title, and nothing between two inline elements adds one. */}
      <span className="sr-only">{`${words}: `}</span>
    </span>
  );
}
