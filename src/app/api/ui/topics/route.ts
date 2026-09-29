import type { NextRequest } from "next/server";
import { json } from "@/agent-api/http";
import { prisma } from "@/store/prisma";
import { listTopics } from "@/topics/store";
import { uiViewer } from "../request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUGGESTIONS = 20;

/** Topic suggestions for the channel builder: `?prefix=`, most recently active first. */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await uiViewer(request);
  if (viewer instanceof Response) {
    return viewer;
  }
  const prefix = (request.nextUrl.searchParams.get("prefix") ?? "").trim().toLowerCase().slice(0, 64);
  return json({ topics: await listTopics(prisma, prefix, SUGGESTIONS) });
}
