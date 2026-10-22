/**
 * The sidebar's date groups, by the day in UK time the conversation was last active, so "Today" turns over at
 * midnight in London rather than in the server's zone.
 */

export type DateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";

export const DATE_GROUPS: readonly DateGroup[] = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

const LONDON = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });

/** Days since the epoch of the date in London. */
function londonDay(at: Date): number {
  const parts = Object.fromEntries(LONDON.formatToParts(at).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86_400_000;
}

export function dateGroup(at: Date, now: Date): DateGroup {
  const days = londonDay(now) - londonDay(at);
  if (days <= 0) {
    return "Today";
  }
  if (days === 1) {
    return "Yesterday";
  }
  if (days <= 7) {
    return "Previous 7 days";
  }
  return days <= 30 ? "Previous 30 days" : "Older";
}

/** The items under each non-empty group, in group order, keeping the items' own order within a group. */
export function groupByDate<T>(items: readonly T[], at: (item: T) => Date, now: Date): { label: DateGroup; items: T[] }[] {
  const groups = new Map<DateGroup, T[]>();
  for (const item of items) {
    const label = dateGroup(at(item), now);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return DATE_GROUPS.flatMap((label) => {
    const grouped = groups.get(label);
    return grouped === undefined ? [] : [{ label, items: grouped }];
  });
}
