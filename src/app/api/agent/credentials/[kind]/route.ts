import { z } from "zod";
import { canUseCredentialRoutes } from "@/access/rules";
import { HttpError, noContent, parse, readJson } from "@/agent-api/http";
import { agentRoute } from "@/agent-api/route";
import type { Caller } from "@/agent-auth/authenticate";
import { type CredentialBackend, credentialBackend } from "@/credentials/backend";
import { type CredentialKind, isCredentialKind } from "@/credentials/names";
import { deleteCredential, putCredential } from "@/credentials/store";
import { checkAzureCacheOwner } from "@/credentials/validate";
import { prisma } from "@/store/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Write-only: there is deliberately no `GET`. A stored value is never returned to anyone. */

const credentialBody = z.object({ value: z.string() });

function kindOf(value: string): CredentialKind {
  if (!isCredentialKind(value)) {
    throw new HttpError(404, "no such kind of credential");
  }
  return value;
}

function personal(caller: Caller): void {
  if (!canUseCredentialRoutes(caller)) {
    throw new HttpError(403, "a virtual agent stores its credentials through /api/virtual/{id}/credentials/{kind}");
  }
}

function available(backend: CredentialBackend) {
  if (!backend.available) {
    throw new HttpError(503, backend.reason);
  }
  return backend.store;
}

export const PUT = agentRoute<{ kind: string }>(async ({ caller, request, params }) => {
  personal(caller);
  const kind = kindOf(params.kind);
  const { value } = parse(credentialBody, await readJson(request));
  if (kind === "azure") {
    const owned = checkAzureCacheOwner(value, caller.oid, process.env.ENTRA_TENANT_ID);
    if (!owned.ok && owned.reason === "unconfigured") {
      throw new HttpError(503, owned.error);
    }
    if (!owned.ok && owned.reason === "not-owner") {
      throw new HttpError(400, owned.error);
    }
  }
  await putCredential(prisma, available(credentialBackend(prisma)), { actorOid: caller.oid, ownerOid: caller.oid, kind, value, via: "cli" });
  return noContent();
});

export const DELETE = agentRoute<{ kind: string }>(async ({ caller, params }) => {
  personal(caller);
  const kind = kindOf(params.kind);
  await deleteCredential(prisma, available(credentialBackend(prisma)), { actorOid: caller.oid, ownerOid: caller.oid, kind });
  return noContent();
});
