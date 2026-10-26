import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { prisma } from "@/store/prisma";
import { failLogin } from "@/virtual-agents/logins";
import { pathKind } from "@/virtual-agents/route-params";
import { loginFailedBody } from "@/virtual-agents/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = virtualRoute<{ virtualAgentId: string; kind: string }>(async ({ virtualAgent, request, params }) => {
  const kind = pathKind(params.kind);
  const body = parse(loginFailedBody, await readJson(request));
  await failLogin(prisma, virtualAgent, kind, { state: body.state, detail: body.detail });
  return noContent();
});
