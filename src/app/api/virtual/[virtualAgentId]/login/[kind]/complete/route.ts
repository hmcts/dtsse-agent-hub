import { noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { credentialBackend } from "@/credentials/backend";
import { prisma } from "@/store/prisma";
import { completeLogin } from "@/virtual-agents/logins";
import { pathKind } from "@/virtual-agents/route-params";
import { completeBody } from "@/virtual-agents/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = virtualRoute<{ virtualAgentId: string; kind: string }>(async ({ virtualAgent, request, params }) => {
  const kind = pathKind(params.kind);
  const body = parse(completeBody, await readJson(request));
  const backend = credentialBackend(prisma);
  await completeLogin(prisma, backend.available ? backend.store : undefined, virtualAgent, kind, {
    accountOid: body.account_oid,
    accountLabel: body.account_label
  });
  return noContent();
});
