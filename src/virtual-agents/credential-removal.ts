import type { CredentialKind } from "../credentials/names.ts";
import { type CredentialTarget, deleteCredential, type SecretStore } from "../credentials/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { restartVirtualAgent } from "./store.ts";

/**
 * Removing one of a person's sign-ins so that it stops being used, which for one a pod holds means a restart: a pod
 * reads its sign-ins as it starts, so a running one would go on using the one removed — and for a token removed
 * because it leaked, that is the opposite of what was asked. Every way a person removes a credential, the web and the
 * agent API alike, comes through here.
 */

/**
 * The sign-ins a pod holds for itself from its start, and which of the owner's agents use each: a Claude token only
 * reaches Claude for an agent on the person's own licence, so an agent on the gateway holds none to stop using.
 */
const HELD_BY: Partial<Record<CredentialKind, "every" | "own-licence">> = {
  github: "every",
  azure: "every",
  atlassian: "every",
  jenkins: "every",
  claude: "own-licence"
};

export interface Removal {
  /** How many running agents could not be restarted, which go on with the removed sign-in until they next start. */
  notRestarted: number;
}

/**
 * Deletes the credential, then restarts the owner's running agents that held it, when one was stored. The deletion is
 * what matters and is done first; a restart that fails is counted rather than thrown, so a removal that worked is never
 * reported as one that did not, and one agent failing does not leave the rest running on it.
 */
export async function removeCredential(prisma: PrismaClient, store: SecretStore, target: CredentialTarget): Promise<Removal> {
  const held = (await prisma.credential.count({ where: { ownerOid: target.ownerOid, kind: target.kind } })) > 0;
  await deleteCredential(prisma, store, target);
  const users = HELD_BY[target.kind];
  if (!held || users === undefined) {
    return { notRestarted: 0 };
  }
  const running = await prisma.virtualAgent.findMany({
    where: { ownerOid: target.ownerOid, desired: "running", ...(users === "own-licence" ? { modelRoute: "own_licence" as const } : {}) },
    select: { id: true }
  });
  let notRestarted = 0;
  for (const agent of running) {
    try {
      await restartVirtualAgent(prisma, target.ownerOid, agent.id, "restarting to stop using a removed sign-in");
    } catch (error) {
      notRestarted += 1;
      console.warn(`could not restart virtual agent ${agent.id} after a sign-in was removed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { notRestarted };
}
