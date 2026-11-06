/**
 * What the role a session was signed in with means for Microsoft 365, at the routes that start and complete a
 * connect and at sign-in. Only someone `canConnectMicrosoft` allows may connect, and a sign-in without that role
 * deletes any connection the person holds, so the connection does not outlive the role.
 */
import { canConnectMicrosoft } from "../access/rules.ts";
import { credentialBackend } from "../credentials/backend.ts";
import { credentialVersion, deleteCredential } from "../credentials/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { modelRouteFor } from "../viewer/identity.ts";

interface SignedIn {
  oid: string;
  name: string;
  aiGateway: boolean;
}

/** Whether a connect may start, on the role the session was signed in with. */
export function mayConnectMicrosoft(session: Pick<SignedIn, "aiGateway">): boolean {
  return canConnectMicrosoft(modelRouteFor(session.aiGateway));
}

/**
 * Whether a connect coming back may be completed. Asked before the code is exchanged, so someone refused is never
 * given a refresh token to keep.
 */
export function mayCompleteMicrosoftConnect(session: Pick<SignedIn, "name" | "aiGateway">): boolean {
  if (mayConnectMicrosoft(session)) {
    return true;
  }
  console.warn(`${session.name} is not an AI Gateway user, so their Microsoft 365 connection was not kept`);
  return false;
}

/**
 * Deletes the Microsoft 365 connection of someone signing in without the role `canConnectMicrosoft` asks for, as
 * Disconnect does. Someone with no connection row costs no trip to the credential store. The sign-in goes ahead
 * whatever happens here: a connection left behind is deleted at their next sign-in, and is no reason to keep them out
 * of the hub.
 */
export async function removeRefusedMicrosoftConnection(prisma: PrismaClient, session: SignedIn): Promise<void> {
  if (mayConnectMicrosoft(session)) {
    return;
  }
  try {
    if ((await credentialVersion(prisma, session.oid, "microsoft")) === undefined) {
      return;
    }
    const backend = credentialBackend(prisma);
    if (!backend.available) {
      throw new Error(backend.reason);
    }
    await deleteCredential(prisma, backend.store, { actorOid: session.oid, ownerOid: session.oid, kind: "microsoft" });
  } catch (failure) {
    console.warn(`${session.name} signed in without the AI Gateway role, and their Microsoft 365 connection could not be deleted: ${String(failure)}`);
  }
}
