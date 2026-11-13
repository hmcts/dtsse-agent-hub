import { errorResponse, HttpError } from "../agent-api/http.ts";
import { sameOriginRequest } from "./origin.ts";
import { pagePath } from "./schemas.ts";
import type { FeedbackThreadFilter } from "./thread-store.ts";

/**
 * What the review shell's routes, `/api/ui/feedback/review/{token}/…`, check before a store is reached, in this order
 * after the session: the request is the hub's own page's (403), and feedback is on (404). A dead or unknown link is
 * the store's 404.
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

const STATUSES = new Set(["open", "resolved", "detached"]);

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
  const status = params.get("status");
  if (status !== null) {
    if (!STATUSES.has(status)) {
      throw new HttpError(400, "status: must be open, resolved or detached");
    }
    filter.status = status as FeedbackThreadFilter["status"];
  }
  return filter;
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
