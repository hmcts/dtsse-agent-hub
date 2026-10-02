import { json, parse, readJson } from "@/agent-api/http";
import { ownedAgentRoute } from "@/agent-api/route";
import { prisma } from "@/store/prisma";
import { transcriptBody } from "@/transcripts/schema";
import { appendEntries } from "@/transcripts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = ownedAgentRoute<{ agentId: string }>(async ({ agent, request }) => {
  const body = parse(transcriptBody, await readJson(request));
  return json({ accepted: await appendEntries(prisma, agent, body.session_id, body.entries) });
});
