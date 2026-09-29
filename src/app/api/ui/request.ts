import type { NextRequest } from "next/server";
import { errorResponse } from "@/agent-api/http";
import type { Identity } from "@/users/identity";
import { viewerFrom } from "@/viewer/identity";

/** The viewer of a `/api/ui/*` request, from its session cookie, or the 401 to answer with. */
export async function uiViewer(request: NextRequest): Promise<Identity | Response> {
  const viewer = await viewerFrom((name) => request.cookies.get(name)?.value);
  return viewer ?? errorResponse(401, "sign in first");
}
