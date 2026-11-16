/**
 * The sidebar's date groups, by the day in UK time the conversation was last active, so "Today" turns over at
 * midnight in London rather than in the server's zone.
 */

export type DateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";

const DATE_GROUPS: readonly DateGroup[] = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

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

export const PINNED = "Pinned";

/** A heading in the sidebar: the Pinned section, then the date groups. */
export type SidebarGroup = typeof PINNED | DateGroup;

/**
 * The sidebar's sections: the pinned items, then every other item under its date group, each in the order given — the
 * caller's, which for the sidebar is the database's: most recently pinned first, and most recently active first. A
 * pinned item is in Pinned alone, and the section is left out while nothing is pinned.
 */
export function groupForSidebar<T>(
  items: readonly T[],
  at: (item: T) => Date,
  isPinned: (item: T) => boolean,
  now: Date
): { label: SidebarGroup; items: T[] }[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    (isPinned(item) ? pinned : rest).push(item);
  }
  const section: { label: SidebarGroup; items: T[] }[] = pinned.length === 0 ? [] : [{ label: PINNED, items: pinned }];
  return [...section, ...groupByDate(rest, at, now)];
}

/** What `bySidebarOrder` reads of an item, chat or feedback project alike. */
export interface SidebarOrdered {
  id: string;
  lastActiveAt: string;
  pinnedAt: string | null;
}

/**
 * The order `groupForSidebar` keeps for a list merged from several sources: the pinned ones first, most recently pinned
 * first, then the rest most recently active first, the id settling a tie so the order does not change between renders.
 */
export function bySidebarOrder(a: SidebarOrdered, b: SidebarOrdered): number {
  if ((a.pinnedAt === null) !== (b.pinnedAt === null)) {
    return a.pinnedAt === null ? 1 : -1;
  }
  const pinned = a.pinnedAt === null || b.pinnedAt === null ? 0 : Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt);
  if (pinned !== 0) {
    return pinned;
  }
  const active = Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
  if (active !== 0) {
    return active;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A row's count of what is new, as its badge shows it: past 99 the exact figure says nothing more. */
export function unreadLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}
