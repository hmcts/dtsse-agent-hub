import { type PodClaims, podSupports } from "../agents/client-features.ts";
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
 * Whether the sidebar offers the briefing: Microsoft 365 is connected, which most of it reads, and the pod's client
 * claims `morning-briefing` (`podSupports`), so the chat it starts has the skill to run. A client ships the skill with
 * the claim, in the m365 plugin every conversation session loads.
 *
 * The pod's claim rather than the skills its sessions report: the pod's main session is not given the bundled plugins,
 * so until a conversation session starts the pod reports none of their skills, and the item that starts that session
 * would never appear. A stopped pod is read through its main-session agent's last claim, so an idle or evening stop
 * does not hide it; a pod that has claimed nothing yet is not offered it.
 */
export function offersBriefing(stored: ReadonlySet<CredentialKind>, claims: PodClaims): boolean {
  return stored.has("microsoft") && podSupports(claims, "morning-briefing");
}
