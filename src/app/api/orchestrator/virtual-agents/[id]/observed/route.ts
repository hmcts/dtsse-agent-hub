import { HttpError, noContent, parse, readJson } from "@/agent-api/http";
import { orchestratorRoute } from "@/agent-api/route";
import { isUuid } from "@/agents/store";
import { prisma } from "@/store/prisma";
import { observedBody } from "@/virtual-agents/schemas";
import { observeVirtualAgent } from "@/virtual-agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = orchestratorRoute<{ id: string }>(async ({ request, params }) => {
  if (!isUuid(params.id)) {
    throw new HttpError(404, "no such virtual agent");
  }
  const body = parse(observedBody, await readJson(request));
  await observeVirtualAgent(prisma, params.id, {
    generation: body.generation,
    replicasReady: body.replicas_ready,
    podPhase: body.pod_phase,
    reason: body.reason,
    diskDeleted: body.disk_deleted ?? false
  });
  return noContent();
});
