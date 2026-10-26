import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { reportMemoryUse } from "@/assistant/memory";
import { memoryReportBody } from "@/assistant/schemas";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the pod's container cgroup says about its memory, which the hub has no other way to learn. */
export const PUT = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent, request }) => {
  await reportMemoryUse(prisma, virtualAgent.id, parse(memoryReportBody, await readJson(request)));
  return noContent();
});
