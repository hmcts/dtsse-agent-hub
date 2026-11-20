import { type CredentialTarget, deleteCredential, type SecretStore } from "../credentials/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import { HELD_BY } from "./held-credentials.ts";
import type { VirtualAgentStatus } from "./lifecycle.ts";
import { restartVirtualAgent } from "./store.ts";

/**
 * Removing one of a person's sign-ins so that it stops being used, which for one a pod holds means a restart: a pod
 * reads its sign-ins as it starts, so a running one would go on using the one removed — and for a token removed
 * because it leaked, that is the opposite of what was asked. Every way a person removes a credential, the web and the
 * agent API alike, comes through here.
 */

/**
 * The statuses of an agent whose pod is up, and so has read its sign-ins. One `requested`, `failed` or stopped reads
 * them when it next starts, and restarting it would only make it read as starting.
 */
const POD_UP: readonly VirtualAgentStatus[] = ["provisioning", "awaiting_credentials", "awaiting_login", "cloning", "running"];

/** Deletes the credential, then restarts the owner's agents with a pod up that held it, when one was stored. */
export async function removeCredential(prisma: PrismaClient, store: SecretStore, target: CredentialTarget): Promise<void> {
  const held = (await prisma.credential.count({ where: { ownerOid: target.ownerOid, kind: target.kind } })) > 0;
  await deleteCredential(prisma, store, target);
  const users = HELD_BY[target.kind];
  if (!held || users === undefined) {
    return;
  }
  const up = await prisma.virtualAgent.findMany({
    where: {
      ownerOid: target.ownerOid,
      desired: "running",
      status: { in: [...POD_UP] },
      ...(users === "own-licence" ? { modelRoute: "own_licence" as const } : {})
    },
    select: { id: true }
  });
  for (const agent of up) {
    await restartVirtualAgent(prisma, target.ownerOid, agent.id, "restarting to stop using a removed sign-in");
  }
}
