/**
 * Times as the UI prints them. A fixed zone rather than the reader's or the pod's, because the server renders the
 * first paint and the browser re-renders live updates: two different zones would print one message two ways and fail
 * hydration. Every function takes `now` so the output is deterministic under test.
 */
const ZONE = "Europe/London";

const SHORT = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const SHORT_WITH_YEAR = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

const FULL = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short"
});

const CALENDAR_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, year: "numeric", month: "numeric", day: "numeric" });

const LONG_DAY = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, weekday: "long", day: "numeric", month: "long" });

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function parse(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The parts `format` gives an instant, looked up by type: "" for one it does not give. */
function partsOf(format: Intl.DateTimeFormat, date: Date | number): (type: Intl.DateTimeFormatPartTypes) => string {
  const parts = format.formatToParts(date);
  return (type) => parts.find((candidate) => candidate.type === type)?.value ?? "";
}

/** The UK calendar day as days since the epoch, so two instants either side of a clock change compare by date. */
function ukDay(date: Date | number): number {
  const part = partsOf(CALENDAR_DAY, date);
  return Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day"))) / DAY_MS;
}

/** The UK calendar day as `YYYY-MM-DD`. */
export function ukIsoDate(date: Date | number): string {
  const part = partsOf(CALENDAR_DAY, date);
  return `${part("year")}-${part("month").padStart(2, "0")}-${part("day").padStart(2, "0")}`;
}

/** The UK calendar day as a person reads it, "Thursday 5 November": joined from its parts, so no locale's comma. */
export function ukLongDate(date: Date | number): string {
  const part = partsOf(LONG_DAY, date);
  return `${part("weekday")} ${part("day")} ${part("month")}`;
}

function ukYear(date: Date | number): string {
  return partsOf(CALENDAR_DAY, date)("year");
}

/** "29 Sept, 15:05", with the year when it is not this year's. */
export function instant(iso: string, now: number = Date.now()): string {
  const date = parse(iso);
  if (date === undefined) {
    return "";
  }
  return (ukYear(date) === ukYear(now) ? SHORT : SHORT_WITH_YEAR).format(date);
}

/** "Tuesday, 29 September 2026 at 15:05 BST (UK time)", for a tooltip. */
export function fullInstant(iso: string): string {
  const date = parse(iso);
  return date === undefined ? "" : `${FULL.format(date)} (UK time)`;
}

/** How long ago, coarsely: "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago", then the date itself. */
export function age(iso: string, now: number): string {
  const date = parse(iso);
  if (date === undefined) {
    return "";
  }
  const elapsed = now - date.getTime();
  if (elapsed < MINUTE_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  }
  // The day the clocks go back has 25 hours, so more than a day can pass on one date.
  const days = ukDay(now) - ukDay(date);
  if (elapsed < DAY_MS || days === 0) {
    return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  }
  if (days === 1) {
    return "yesterday";
  }
  return days < 7 ? `${days} days ago` : instant(iso, now);
}

function plural(amount: number, unit: string): string {
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

/** A length of time in the largest of hours, minutes and seconds that divides it exactly: "24 hours", "90 seconds". */
export function duration(seconds: number): string {
  if (seconds % 3600 === 0) {
    return plural(seconds / 3600, "hour");
  }
  return seconds % 60 === 0 ? plural(seconds / 60, "minute") : plural(seconds, "second");
}
