import { HttpError } from "../agent-api/http.ts";
import type { MicrosoftRefresh } from "../auth/entra.ts";
import { deleteCredential, putCredential, readCredential, type SecretStore } from "../credentials/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { accessTokenView, type MicrosoftAccessToken, parseSignIn, serialiseSignIn } from "./microsoft.ts";

/**
 * A Graph access token for a person, minted in the hub from their Microsoft 365 connection, for their own pod or for
 * them at their own command line. The refresh token is redeemed here with the hub's client secret and never handed
 * out; what Entra rotates it to is kept in its place.
 */
export async function mintMicrosoftToken(
  prisma: PrismaClient,
  store: SecretStore,
  ownerOid: string,
  refresh: (refreshToken: string) => Promise<MicrosoftRefresh>,
  now: () => number = Date.now
): Promise<MicrosoftAccessToken> {
  const stored = await readCredential(prisma, store, ownerOid, "microsoft");
  const signIn = stored === undefined ? undefined : parseSignIn(stored);
  if (signIn === undefined) {
    throw new HttpError(404, "Microsoft 365 is not connected: connect it in the CFT Workspace's settings, under Connections");
  }

  const answer = await refresh(signIn.refreshToken);
  if (!answer.ok) {
    if (answer.failure === "reconnect") {
      // A refresh token Entra refuses never works again, so it goes, and settings says "Not connected" rather than a
      // connection that every agent is refused through.
      await deleteCredential(prisma, store, { actorOid: ownerOid, ownerOid, kind: "microsoft" });
      throw new HttpError(409, "the Microsoft 365 connection has lapsed: connect it again in the CFT Workspace's settings, under Connections");
    }
    console.warn(`a Microsoft Graph token could not be minted: ${answer.error}`);
    throw new HttpError(502, "Microsoft did not answer the token request; try again shortly");
  }

  const scope = answer.scope === "" ? signIn.scope : answer.scope;
  if (answer.refreshToken !== undefined && (answer.refreshToken !== signIn.refreshToken || scope !== signIn.scope)) {
    await putCredential(prisma, store, {
      actorOid: ownerOid,
      ownerOid,
      kind: "microsoft",
      value: serialiseSignIn({ ...signIn, refreshToken: answer.refreshToken, scope }),
      via: "web"
    });
  }
  return accessTokenView(answer.accessToken, answer.expiresIn, scope, now());
}

/**
 * The hub's Entra settings for a refresh, or 503: a deployment without its client secret (preview mounts only the
 * client id) cannot redeem a refresh token, and must say so rather than call Microsoft with half a client.
 */
export function refreshSettings<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new HttpError(503, `Microsoft 365 tokens are not available on this deployment: ${error instanceof Error ? error.message : String(error)}`);
  }
}
