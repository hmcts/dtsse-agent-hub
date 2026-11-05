import { DEFAULT_PRODUCT } from "./products.ts";

/**
 * The morning briefing the sidebar's plus offers to someone who has connected Microsoft 365: a new chat whose first
 * message runs the m365 plugin's `morning-briefing` skill. The procedure lives in the skill, so the message only names
 * it and the day it is for; the day is the UK's, since that is the working day the briefing covers whatever clock the
 * browser is on.
 *
 * Pure, so the request a click sends is unit-tested; `WorkflowsMenu` sends it through `startConversation`.
 */

/** The skill the first message invokes, as the "/" menu names a bundled plugin's skill. */
export const BRIEFING_SKILL = "m365:morning-briefing";

const UK = "Europe/London";

function ukParts(now: Date, options: Intl.DateTimeFormatOptions): Map<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: UK, ...options }).formatToParts(now);
  return new Map(parts.map((part) => [part.type, part.value]));
}

/** The UK date as `YYYY-MM-DD`. */
export function ukDate(now: Date): string {
  const parts = ukParts(now, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

/** The UK date as a person reads it, `Thursday 5 November`. */
export function ukDay(now: Date): string {
  const parts = ukParts(now, { weekday: "long", day: "numeric", month: "long" });
  return `${parts.get("weekday")} ${parts.get("day")} ${parts.get("month")}`;
}

/** What `startConversation` is sent for a briefing started at `now`: the default product, since a briefing spans them all. */
export function briefingRequest(now: Date): { product: string; title: string; body: string } {
  return { product: DEFAULT_PRODUCT, title: `Morning briefing, ${ukDay(now)}`, body: `/${BRIEFING_SKILL} ${ukDate(now)}` };
}
