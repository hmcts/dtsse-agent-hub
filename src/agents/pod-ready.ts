import type { PrismaClient } from "../store/prisma.ts";
import { setDesired } from "../virtual-agents/store.ts";
import { type ClientFeature, type PodClaims, type PodJobFeature, podGate } from "./client-features.ts";

/** What `podReady` needs of a virtual agent: its lifecycle columns and the claims `podGate` reads. */
export interface PodReadiness {
  assistant: { id: string; desired: string; status: string; generation: number; observedGeneration: number };
  claims: PodClaims;
}

/**
 * Whether a frame needing `feature` could be sent to the virtual agent's pod now, changing nothing: `stopped`, `waking`
 * for one still booting (`podGate`) or with a change the orchestrator has not applied yet, such as a plugin just
 * ticked, since the pod running now is the one about to be replaced and would lose the frame, `unsupported`, or `ok`.
 */
export function podState({ assistant, claims }: PodReadiness, feature: ClientFeature | PodJobFeature): "stopped" | "waking" | "unsupported" | "ok" {
  if (assistant.desired === "stopped") {
    return "stopped";
  }
  const gate = podGate({ status: assistant.status, ...claims }, feature);
  if (gate !== "ok") {
    return gate;
  }
  return assistant.generation > assistant.observedGeneration ? "waking" : "ok";
}

/** Whether a frame needing `feature` may be sent to the virtual agent's pod now (`podState`); a stopped one is started, by `actorOid`, and is `waking`. */
export async function podReady(
  prisma: PrismaClient,
  actorOid: string,
  readiness: PodReadiness,
  feature: ClientFeature | PodJobFeature,
  now: Date
): Promise<"waking" | "unsupported" | "ok"> {
  const state = podState(readiness, feature);
  if (state !== "stopped") {
    return state;
  }
  await setDesired(prisma, actorOid, readiness.assistant.id, "running", now);
  return "waking";
}
