import { HttpError, json, parse, readJson } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import { registerBody } from "@/agent-api/schemas";
import { registerAgent, SessionOwnedElsewhere } from "@/agents/store";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = agentRoute(async ({ caller, request }) => {
  const body = parse(registerBody, await readJson(request));
  try {
    const agent = await registerAgent(prisma, caller, {
      sessionId: body.session_id,
      name: body.name,
      cwd: body.cwd,
      repo: body.repo,
      branch: body.branch,
      host: body.host,
      skills: body.skills
    });
    return json({ agent_id: agent.id, name: agent.name });
  } catch (error) {
    if (error instanceof SessionOwnedElsewhere) {
      throw new HttpError(409, error.message);
    }
    throw error;
  }
});
