import type { NextRequest } from "next/server";
import { reviewRefusal } from "@/feedback/review-api";
import { feedbackEnabled } from "@/feedback/settings";
import { viewerSettings } from "@/port-viewer/settings";
import type { Identity } from "@/users/identity";
import { uiRefusals, uiViewer } from "../../request";

/**
 * Runs one of the review shell's handlers: signed in (401), from the hub's own page (403), feedback on (404), and any
 * `HttpError` the stores raise rendered as the contract's `{"error": …}`.
 */
export async function reviewRoute(request: NextRequest, name: string, work: (viewer: Identity) => Promise<Response>): Promise<Response> {
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
