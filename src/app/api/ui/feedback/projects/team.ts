import type { NextRequest } from "next/server";
import { reviewRefusal } from "@/feedback/review-api";
import { feedbackEnabled } from "@/feedback/settings";
import { viewerSettings } from "@/port-viewer/settings";
import type { Identity } from "@/users/identity";
import { uiRefusals, uiViewer } from "../../request";

/**
 * Runs one of the team pages' reads, `/api/ui/feedback/projects/{id}/…`: signed in (401), from the hub's own page
 * (403), feedback on (404). Whether the viewer is on the project's team is the store's, which reports anyone else's
 * project as not there. The prototype in a review frame is on a sibling host, so the same-origin check applies to
 * these reads as to the review shell's.
 */
export async function teamRoute(request: NextRequest, name: string, work: (viewer: Identity) => Promise<Response>): Promise<Response> {
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

const STATUSES = new Set(["open", "resolved", "detached"]);

/** `?link=&page=&status=&author=` of the team's thread read, each optional. */
export function teamThreadQuery(params: URLSearchParams): {
  linkId?: string;
  pagePath?: string;
  status?: "open" | "resolved" | "detached";
  authorOid?: string;
} {
  const value = (name: string) => {
    const raw = params.get(name);
    return raw === null || raw === "" ? undefined : raw;
  };
  const status = value("status");
  return {
    linkId: value("link"),
    pagePath: value("page"),
    authorOid: value("author"),
    status: status !== undefined && STATUSES.has(status) ? (status as "open" | "resolved" | "detached") : undefined
  };
}
