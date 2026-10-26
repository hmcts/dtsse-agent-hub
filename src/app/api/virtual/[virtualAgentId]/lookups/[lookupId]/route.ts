import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { answerLookup } from "@/assistant/lookup-store";
import { lookupAnswerBody } from "@/assistant/lookups";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The pod's answer to one of its owner's lookups: what twg found, or why it found nothing. */
export const PUT = virtualRoute<{ virtualAgentId: string; lookupId: string }>(async ({ virtualAgent, request, params }) => {
  await answerLookup(prisma, virtualAgent, params.lookupId, parse(lookupAnswerBody, await readJson(request)));
  return noContent();
});
