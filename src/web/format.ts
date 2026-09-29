/**
 * Times as the UI prints them. A fixed zone rather than the reader's, because the server renders the first paint and
 * the browser re-renders live updates: two different zones would print one message two ways and fail hydration.
 */
const INSTANT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

export function instant(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : INSTANT.format(date);
}
