import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { prisma } from "@/store/prisma";
import { startLogin } from "@/virtual-agents/logins";
import { pathKind } from "@/virtual-agents/route-params";
import { loginBody } from "@/virtual-agents/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = virtualRoute<{ virtualAgentId: string; kind: string }>(async ({ virtualAgent, request, params }) => {
  const kind = pathKind(params.kind);
  const body = parse(loginBody, await readJson(request));
  await startLogin(prisma, virtualAgent, kind, {
    prompt: body.prompt,
    verificationUri: body.verification_uri,
    userCode: body.user_code ?? null,
    expiresInSeconds: body.expires_in
  });
  return noContent();
});
