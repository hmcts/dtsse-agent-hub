import { canVirtualAgentStoreCredential } from "@/access/rules";
import { HttpError, json, noContent, parse, readJson } from "@/agent-api/http";
import { virtualRoute } from "@/agent-api/route";
import { DEFAULT_CLAUDE_MD } from "@/credentials/claude-md";
import { putCredential, readCredential } from "@/credentials/store";
import { checkAzureCacheOwner } from "@/credentials/validate";
import { prisma } from "@/store/prisma";
import { failForAzureAccount } from "@/virtual-agents/logins";
import { pathKind, requireStore } from "@/virtual-agents/route-params";
import { credentialValueBody } from "@/virtual-agents/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The one path that reads every kind of credential's value back: the owner's own virtual agent, with its launch
 * token, fetching what it needs to act for them. No person, and no other agent of theirs, can call it. A CLAUDE.md
 * the owner has not written is the default, so every pod writes one.
 */
export const GET = virtualRoute<{ virtualAgentId: string; kind: string }>(async ({ virtualAgent, params }) => {
  const kind = pathKind(params.kind);
  const value = await readCredential(prisma, requireStore(prisma), virtualAgent.ownerOid, kind);
  if (value === undefined) {
    if (kind === "claude_md") {
      return json({ value: DEFAULT_CLAUDE_MD });
    }
    throw new HttpError(404, `no ${kind} credential is stored`);
  }
  return json({ value });
});

/**
 * An Azure token cache must be signed in as the owner alone. One that is not is refused with 409, never stored, and
 * fails the agent, as a `complete` naming another account does; one that does not decode is left to the ordinary
 * value check's 400. A CLAUDE.md or a git identity is refused with 403 (`canVirtualAgentStoreCredential`).
 */
export const PUT = virtualRoute<{ virtualAgentId: string; kind: string }>(async ({ virtualAgent, request, params }) => {
  const kind = pathKind(params.kind);
  if (!canVirtualAgentStoreCredential(kind)) {
    throw new HttpError(403, `only its owner can change their ${kind === "claude_md" ? "CLAUDE.md" : "git identity"}, on agent-hub's virtual agents page`);
  }
  const { value } = parse(credentialValueBody, await readJson(request));
  const owner = virtualAgent.ownerOid;
  if (kind === "azure") {
    const owned = checkAzureCacheOwner(value, owner, process.env.ENTRA_TENANT_ID);
    if (!owned.ok && owned.reason === "unconfigured") {
      throw new HttpError(503, owned.error);
    }
    if (!owned.ok && owned.reason === "not-owner") {
      await failForAzureAccount(prisma, virtualAgent, `the Azure token cache the agent saved was refused: ${owned.error}; sign in as yourself`);
      throw new HttpError(409, owned.error);
    }
  }
  await putCredential(prisma, requireStore(prisma), { actorOid: owner, ownerOid: owner, kind, value, via: "pod" });
  return noContent();
});
