import { fullInstant, instant } from "@/web/format";

/**
 * A time as a `<time>` element: the short form on screen, the full date and zone as a tooltip. `children` replaces the
 * short form, as a relative age does once the browser has a clock.
 *
 * `suppressHydrationWarning` because the server and the browser may disagree on this year's number at New Year, and
 * their ICU builds may word the tooltip differently; either is harmless, and a mismatch would re-render the boundary.
 */
export function Timestamp({ iso, className, children }: { iso: string; className?: string; children?: React.ReactNode }) {
  return (
    <time dateTime={iso} title={fullInstant(iso)} className={className} suppressHydrationWarning>
      {children ?? instant(iso)}
    </time>
  );
}
