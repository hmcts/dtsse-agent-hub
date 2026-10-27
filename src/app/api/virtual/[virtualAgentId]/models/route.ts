import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { reportModelAccess } from "@/assistant/model-access-store";
import { modelCheckBody } from "@/assistant/schemas";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which Claude models its owner's credential answered on this virtual agent's route, from its pod's own check. */
export const POST = virtualRoute<{ virtualAgentId: string }>(async ({ virtualAgent, request }) => {
  await reportModelAccess(prisma, virtualAgent, parse(modelCheckBody, await readJson(request)).models);
  return noContent();
});
