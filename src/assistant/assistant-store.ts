import type { PodClaims } from "../agents/client-features.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import { createVirtualAgent, findVirtualAgent, setDesired, type VirtualAgentRow } from "../virtual-agents/store.ts";

const ASSISTANT_NAME = "assistant";

/**
 * The virtual agent the person's Assistant runs on: their first, the oldest not being deleted. Any virtual agent can
 * hold conversations; the Assistant always uses the same one, so a person's chats are in one place.
 */
export async function findAssistant(db: Database, ownerOid: string): Promise<VirtualAgentRow | undefined> {
  return (await findAssistantWithClaims(db, ownerOid))?.assistant;
}

/** `findAssistant`, with the pod's client-features claims read in the same lookup, for a gate on `podGate`. */
export async function findAssistantWithClaims(db: Database, ownerOid: string): Promise<{ assistant: VirtualAgentRow; claims: PodClaims } | undefined> {
  const row = await db.virtualAgent.findFirst({
    where: { ownerOid, desired: { not: "deleted" } },
    select: { id: true, clientFeatures: true, agent: { select: { clientFeatures: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  const assistant = row === null ? undefined : await findVirtualAgent(db, row.id);
  return row === null || assistant === undefined ? undefined : { assistant, claims: { clientFeatures: row.clientFeatures, agent: row.agent } };
}

/** `assistant`, or `assistant-2` and on when an earlier one of that name is still being deleted. */
async function freeName(db: Database, ownerOid: string): Promise<string> {
  const taken = new Set((await db.virtualAgent.findMany({ where: { ownerOid }, select: { name: true } })).map((row) => row.name));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? ASSISTANT_NAME : `${ASSISTANT_NAME}-${n}`;
    if (!taken.has(name)) {
      return name;
    }
  }
}

/**
 * The virtual agent the person's Assistant runs on: their first, created as `assistant` when they have none, and
 * started whenever they come back to it stopped, so the pod is warming up while they sign in or type. It is an
 * ordinary virtual agent and counts towards their limit. Two tabs racing to create one are settled by the unique
 * name: the loser reads the winner's.
 */
export async function ensureAssistant(prisma: PrismaClient, owner: { oid: string; modelRoute: ModelRoute }): Promise<VirtualAgentRow> {
  return (await ensureAssistantWithClaims(prisma, owner)).assistant;
}

/** A virtual agent just created, whose pod has not booted, so has claimed nothing either way. */
const NO_CLAIMS: PodClaims = { clientFeatures: null, agent: null };

/**
 * `ensureAssistant`, with the pod's client-features claims from the lookup that found it. Those read before a start
 * still hold after it: every stop clears the pod's own claim and its launch token, so a stopped pod can have made no
 * claim since, and the start leaves the main-session agent's claim alone.
 */
export async function ensureAssistantWithClaims(
  prisma: PrismaClient,
  owner: { oid: string; modelRoute: ModelRoute }
): Promise<{ assistant: VirtualAgentRow; claims: PodClaims }> {
  const existing = await findAssistantWithClaims(prisma, owner.oid);
  if (existing !== undefined) {
    const { assistant, claims } = existing;
    return { assistant: assistant.desired === "stopped" ? await setDesired(prisma, owner.oid, assistant.id, "running") : assistant, claims };
  }
  try {
    return { assistant: await createVirtualAgent(prisma, { owner, modelRoute: owner.modelRoute, name: await freeName(prisma, owner.oid) }), claims: NO_CLAIMS };
  } catch (error) {
    const raced = await findAssistantWithClaims(prisma, owner.oid);
    if (raced !== undefined) {
      return raced;
    }
    throw error;
  }
}
