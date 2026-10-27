import { clientSupports } from "../agents/client-features.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { isKnownModel, type ModelOffer, type ModelStatus, modelOffer } from "./models.ts";

/**
 * What a person's pod found their credential can use, and what they are offered from it. One row per person, model
 * route and model, because the credential is per person and route. See Model access in `docs/agent-api.md`.
 */

type StoredRoute = "bedrock" | "own_licence";

/** One model's result as the pod sent it, already checked against `modelCheckBody`. */
export interface ModelCheckResult {
  model: string;
  status: "available" | "unavailable" | "unknown";
}

/**
 * Stores a pod's check for its owner on its route. `unknown` writes nothing, so a check that could not tell keeps
 * whatever was last known; an id the catalogue does not hold is ignored rather than refused, because a newer pod client
 * may ask about one this hub does not offer yet. The `virtual_agent` event is what re-renders an open Assistant page,
 * which reads the offer when it renders.
 */
export async function reportModelAccess(
  prisma: PrismaClient,
  virtualAgent: { id: string; ownerOid: string; modelRoute: "bedrock" | "own-licence" },
  results: readonly ModelCheckResult[],
  now: Date = new Date()
): Promise<void> {
  const modelRoute: StoredRoute = virtualAgent.modelRoute === "own-licence" ? "own_licence" : "bedrock";
  const definite = results.filter((result): result is { model: string; status: ModelStatus } => result.status !== "unknown" && isKnownModel(result.model));
  if (definite.length === 0) {
    return;
  }
  await prisma.$transaction(async (tx) => {
    for (const { model, status } of definite) {
      await tx.assistantModelAccess.upsert({
        where: { ownerOid_modelRoute_model: { ownerOid: virtualAgent.ownerOid, modelRoute, model } },
        create: { ownerOid: virtualAgent.ownerOid, modelRoute, model, status, checkedAt: now },
        update: { status, checkedAt: now }
      });
    }
    await notify(tx, { type: "virtual_agent", virtual_agent_id: virtualAgent.id, owner_oid: virtualAgent.ownerOid });
  });
}

/**
 * What the owner of `virtualAgentId` is offered for conversations on it: the stored answers for its owner and route,
 * when its pod's client claims `model-check`. Without the claim the stored answers are not used, because nothing on
 * that pod will ever check again and an answer from before would stand for good. A virtual agent that does not exist
 * is offered the default, as one that has never checked is.
 */
export async function readModelOffer(db: Database, virtualAgentId: string): Promise<ModelOffer> {
  const agent = await db.virtualAgent.findUnique({
    where: { id: virtualAgentId },
    select: { ownerOid: true, modelRoute: true, agent: { select: { clientFeatures: true } } }
  });
  if (agent === null || !clientSupports(agent.agent?.clientFeatures, "model-check")) {
    return modelOffer(undefined);
  }
  const rows = await db.assistantModelAccess.findMany({
    where: { ownerOid: agent.ownerOid, modelRoute: agent.modelRoute },
    select: { model: true, status: true }
  });
  return modelOffer(new Map(rows.map((row) => [row.model, row.status === "available" ? "available" : "unavailable"])));
}
