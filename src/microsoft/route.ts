import { canConnectMicrosoft } from "../access/rules.ts";
import { HttpError, json } from "../agent-api/http.ts";
import { refreshMicrosoftToken } from "../auth/entra.ts";
import { authSettings } from "../auth/settings.ts";
import type { CredentialVia } from "../credentials/store.ts";
import { prisma } from "../store/prisma.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import { requireStore } from "../virtual-agents/route-params.ts";
import { mintMicrosoftToken, refreshSettings } from "./token.ts";

/** What the token routes answer someone `canConnectMicrosoft` refuses, worded so an agent tells the person and stops. */
export const NOT_ON_GATEWAY = "Microsoft 365 is only available to AI Gateway users, so no token is minted for this person; do not retry";

/**
 * What both token routes answer, once each has decided whose connection it is: the owner's for a pod, the caller's
 * own for a person. `via` is who asked, recorded on any rotation it writes. `route` is the one the caller's own
 * credential says the owner is on, which `canConnectMicrosoft` judges before the connection is read, so a connection
 * kept by someone off the gateway is never redeemed.
 */
export async function microsoftTokenResponse(ownerOid: string, via: CredentialVia, route: ModelRoute): Promise<Response> {
  if (!canConnectMicrosoft(route)) {
    throw new HttpError(403, NOT_ON_GATEWAY);
  }
  const settings = refreshSettings(authSettings);
  return json(await mintMicrosoftToken(prisma, requireStore(prisma), { ownerOid, via, refresh: (token) => refreshMicrosoftToken(settings, token) }));
}
