import { json } from "../agent-api/http.ts";
import { refreshMicrosoftToken } from "../auth/entra.ts";
import { authSettings } from "../auth/settings.ts";
import type { CredentialVia } from "../credentials/store.ts";
import { prisma } from "../store/prisma.ts";
import { requireStore } from "../virtual-agents/route-params.ts";
import { mintMicrosoftToken, refreshSettings } from "./token.ts";

/**
 * What both token routes answer, once each has decided whose connection it is: the owner's for a pod, the caller's
 * own for a person. `via` is who asked, recorded on any rotation it writes.
 */
export async function microsoftTokenResponse(ownerOid: string, via: CredentialVia): Promise<Response> {
  const settings = refreshSettings(authSettings);
  return json(await mintMicrosoftToken(prisma, requireStore(prisma), { ownerOid, via, refresh: (token) => refreshMicrosoftToken(settings, token) }));
}
