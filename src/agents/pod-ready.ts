import type { PrismaClient } from "../store/prisma.ts";
import { setDesired } from "../virtual-agents/store.ts";
import { type ClientFeature, type PodClaims, podGate } from "./client-features.ts";

/** What `podReady` needs of a virtual agent: its lifecycle columns and the claims `podGate` reads. */
export interface PodReadiness {
  assistant: { id: string; desired: string; status: string; generation: number; observedGeneration: number };
  claims: PodClaims;
}

/**
 * Whether a frame needing `feature` may be sent to the virtual agent's pod now. A stopped one is started, by `actorOid`,
 * and is `waking`; so is one still booting (`podGate`), and one with a change the orchestrator has not applied yet,
 * such as a plugin just ticked, since the pod running now is the one about to be replaced and would lose the frame.
 */
export async function podReady(
  prisma: PrismaClient,
  actorOid: string,
  { assistant, claims }: PodReadiness,
  feature: ClientFeature,
  now: Date
): Promise<"waking" | "unsupported" | "ok"> {
  if (assistant.desired === "stopped") {
    await setDesired(prisma, actorOid, assistant.id, "running", now);
    return "waking";
  }
  const gate = podGate({ status: assistant.status, ...claims }, feature);
  if (gate !== "ok") {
    return gate;
  }
  return assistant.generation > assistant.observedGeneration ? "waking" : "ok";
}
