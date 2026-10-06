import { HttpError, noContent, parse, readJson } from "@/agent-api/http";
import { orchestratorRoute } from "@/agent-api/route";
import { isUuid } from "@/agents/store";
import { prisma } from "@/store/prisma";
import { applyFailedBody } from "@/virtual-agents/schemas";
import { recordApplyError } from "@/virtual-agents/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = orchestratorRoute<{ id: string }>(async ({ request, params }) => {
  if (!isUuid(params.id)) {
    throw new HttpError(404, "no such virtual agent");
  }
  const body = parse(applyFailedBody, await readJson(request));
  await recordApplyError(prisma, params.id, { generation: body.generation, error: body.error });
  return noContent();
});
