import type { Skill } from "../agents/skills.ts";
import type { CredentialKind } from "../credentials/names.ts";
import { ukIsoDate, ukLongDate } from "../web/format.ts";
import { DEFAULT_PRODUCT } from "./products.ts";

/**
 * The morning briefing the sidebar's plus offers: a new chat whose first message runs the m365 plugin's
 * `morning-briefing` skill. The procedure lives in the skill, so the message only names it and the day it is for; the
 * day is the UK's, since that is the working day the briefing covers whatever clock the browser is on.
 *
 * Pure, so the request a click sends is unit-tested; `WorkflowsMenu` sends it through `startConversation`.
 */

/** The skill the first message invokes, as the "/" menu names a bundled plugin's skill. */
export const BRIEFING_SKILL = "m365:morning-briefing";

/** What `startConversation` is sent for a briefing started at `now`: the default product, since a briefing spans them all. */
export function briefingRequest(now: Date): { product: string; title: string; body: string } {
  return { product: DEFAULT_PRODUCT, title: `Morning briefing, ${ukLongDate(now)}`, body: `/${BRIEFING_SKILL} ${ukIsoDate(now)}` };
}

/**
 * Whether the sidebar offers the briefing: Microsoft 365 is connected, which most of it reads, and the pod reports the
 * skill, so the chat it starts has something to run. A pod that has not reported its skills yet is not offered it.
 */
export function offersBriefing(stored: ReadonlySet<CredentialKind>, podSkills: readonly Skill[]): boolean {
  return stored.has("microsoft") && podSkills.some((skill) => skill.name === BRIEFING_SKILL);
}
