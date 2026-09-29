import type { NextRequest } from "next/server";
import { noContent } from "@/agent-api/http";
import { uiViewer } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 204 while the tab's session is good and 401 once it has ended: what the UI asks when a request has failed. */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  return viewer instanceof Response ? viewer : noContent();
}
