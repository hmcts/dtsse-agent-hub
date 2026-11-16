import type { NextRequest } from "next/server";
import { errorResponse, HttpError } from "../agent-api/http.ts";
import { uiRefusals, uiViewer } from "../app/api/ui/request.ts";
import { sameOriginRequest } from "../auth/guard.ts";
import { viewerSettings } from "../port-viewer/settings.ts";
import type { Identity } from "../users/identity.ts";
import { pagePath } from "./schemas.ts";
import { feedbackEnabled } from "./settings.ts";
import type { FeedbackThreadFilter, FeedbackThreadStatus } from "./thread-store.ts";

/**
 * What every feedback route, the review shell's `/api/ui/feedback/review/{token}/…` and the team pages'
 * `/api/ui/feedback/projects/{id}/…`, checks before a store is reached, in this order after the session: the request
 * is the hub's own page's (403), and feedback is on (404). A dead or unknown link, or a project the viewer is not on
 * the team of, is the store's 404.
 *
 * The proxy already refuses a write to `/api/ui/` from anywhere but the hub's own page; this check is what holds a
 * read to the same, since a prototype in a review frame is on a sibling host and its `no-cors` GETs carry the session.
 */

export interface ReviewGate {
  /** The hub's public origin, `undefined` while the viewer is off, which leaves feedback off too. */
  hubOrigin: string | undefined;
  enabled: boolean;
}

export function reviewRefusal(request: Request, gate: ReviewGate): Response | undefined {
  if (gate.hubOrigin !== undefined && !sameOriginRequest(request, gate.hubOrigin)) {
    return errorResponse(403, "that request did not come from the hub's own page");
  }
  if (!gate.enabled || gate.hubOrigin === undefined) {
    return errorResponse(404, "prototype feedback is not available on this deployment");
  }
  return undefined;
}

/**
 * Runs one feedback route's handler: signed in (401), `reviewRefusal`, and any `HttpError` the stores raise rendered
 * as the contract's `{"error": …}`.
 */
export async function feedbackRoute(request: NextRequest, name: string, work: (viewer: Identity) => Promise<Response>): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const refusal = reviewRefusal(request, { hubOrigin: viewerSettings()?.hubOrigin, enabled: feedbackEnabled() });
  if (refusal !== undefined) {
    return refusal;
  }
  return await uiRefusals(name, () => work(viewer));
}

const STATUSES: ReadonlySet<string> = new Set<FeedbackThreadStatus>(["open", "resolved", "detached"]);

/** A `status=` filter, or `undefined` when none was given; any other value is a 400. */
export function threadStatus(raw: string | undefined): FeedbackThreadStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!STATUSES.has(raw)) {
    throw new HttpError(400, "status: must be open, resolved or detached");
  }
  return raw as FeedbackThreadStatus;
}

/** `?page_path=&status=` of the shell's thread read: both optional, and a 400 naming the one that is malformed. */
export function threadQuery(params: URLSearchParams): Pick<FeedbackThreadFilter, "pagePath" | "status"> {
  const filter: Pick<FeedbackThreadFilter, "pagePath" | "status"> = {};
  const path = params.get("page_path");
  if (path !== null) {
    if (!pagePath.safeParse(path).success) {
      throw new HttpError(400, "page_path: must be a path starting with /");
    }
    filter.pagePath = path;
  }
  const status = threadStatus(params.get("status") ?? undefined);
  if (status !== undefined) {
    filter.status = status;
  }
  return filter;
}

/** `?link=&page=&status=&author=` of the team's thread read, each optional and an empty one the same as none. */
export function teamThreadQuery(params: URLSearchParams): FeedbackThreadFilter {
  const value = (name: string) => {
    const raw = params.get(name);
    return raw === null || raw === "" ? undefined : raw;
  };
  return { linkId: value("link"), pagePath: value("page"), authorOid: value("author"), status: threadStatus(value("status")) };
}

/** No answer of these routes is worth a cache keeping: each is one person's view of a live link. */
export function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

/**
 * Where the review frame lands: the page asked for (a reload, or the viewer sending a timed-out frame back), else the
 * path and query of the link's own address, so a link to `/start` opens on `/start`.
 */
export function reviewLanding(targetUrl: string, requested: string | string[] | undefined): string {
  if (typeof requested === "string" && requested !== "") {
    return requested;
  }
  const url = new URL(targetUrl);
  return `${url.pathname}${url.search}`;
}
