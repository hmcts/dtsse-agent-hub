import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { uploadsReportBody } from "@/assistant/schemas";
import { reportUploadsOnDisk } from "@/assistant/upload-disk";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the pod's volume holds, which the hub has no other way to learn: every call between the two is pod to hub. */
export const PUT = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent, request }) => {
  await reportUploadsOnDisk(prisma, virtualAgent.id, parse(uploadsReportBody, await readJson(request)));
  return noContent();
});
