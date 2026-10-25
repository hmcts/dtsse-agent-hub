import type { NextRequest } from "next/server";
import { errorResponse, HttpError } from "@/agent-api/http";
import type { Identity } from "@/users/identity";
import { viewerFrom } from "@/viewer/identity";

/** The viewer of a `/api/ui/*` request, from its session cookie, or the 401 to answer with. */
export async function uiViewer(request: NextRequest): Promise<Identity | Response> {
  const viewer = await viewerFrom((name) => request.cookies.get(name)?.value);
  return viewer ?? errorResponse(401, "sign in first");
}

/**
 * Renders a refusal as the contract's `{"error": …}`, as `agentRoute` does for the agent API. A `/api/ui/*` handler
 * needs its own, because it authenticates from the cookie rather than through those wrappers.
 */
export async function uiRefusals(name: string, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse(error.status, error.message, error.extra);
    }
    console.error(`a ${name} request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return errorResponse(500, "internal error");
  }
}
