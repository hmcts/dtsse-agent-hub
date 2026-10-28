import { HttpError } from "../agent-api/http.ts";
import { clientSupports } from "../agents/client-features.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { DEFAULT_MODEL, isKnownModel } from "./models.ts";

/**
 * The Claude model a person's chats run on: one choice each, stored as one row, read for every page that shows it and
 * for every wake and frame their pod is sent. The `owner_oid` in each query is what makes another person's unreachable.
 */

/**
 * Their choice, or the default when they have none — and also when the stored id has left the catalogue, so a model
 * the Assistant has stopped offering reads as, and is sent to the pod as, one it does offer.
 */
export async function readAssistantModel(db: Database, ownerOid: string): Promise<string> {
  const row = await db.assistantModelChoice.findUnique({ where: { ownerOid }, select: { model: true } });
  return isKnownModel(row?.model) ? row.model : DEFAULT_MODEL;
}

/** What the settings' Model section is given: the stored choice, and whether the pod holding it can act on one. */
export interface AssistantModelChoice {
  model: string;
  /**
   * Whether the pod running their assistant takes a bare family alias. `false` for a pod on a client predating the
   * aliases, which drops one and leaves every session on hai's default for the route whatever is chosen here.
   */
  honoured: boolean;
}

/**
 * Their choice and whether their assistant's pod can act on it.
 *
 * `honoured` comes from the pod's *own* session — the virtual agent's current agent, which is the supervisor's
 * registration — because the supervisor is what starts a session on the model, as the Files and Size sections read
 * their own reports from it. A pod runs whatever client it booted with, so this is per pod and changes when it
 * restarts; nothing is gated on it, since a choice saved now is honoured by whatever starts next.
 */
export async function assistantModelChoice(prisma: PrismaClient, ownerOid: string, virtualAgentId: string): Promise<AssistantModelChoice> {
  const [model, agent] = await Promise.all([
    readAssistantModel(prisma, ownerOid),
    prisma.virtualAgent.findUnique({ where: { id: virtualAgentId, ownerOid }, select: { agent: { select: { clientFeatures: true } } } })
  ]);
  return { model, honoured: clientSupports(agent?.agent?.clientFeatures, "model-alias") };
}

/**
 * Replaces their choice, and answers it as stored. Refused for anything but a catalogue id, as the stores that take a
 * product or a template name refuse their own bad input: the id reaches a launcher's command line and a tmux pane as
 * keys on the pod.
 */
export async function saveAssistantModel(db: Database, ownerOid: string, model: unknown, now: Date = new Date()): Promise<string> {
  if (!isKnownModel(model)) {
    throw new HttpError(400, "pick a model from the list");
  }
  await db.assistantModelChoice.upsert({ where: { ownerOid }, create: { ownerOid, model, updatedAt: now }, update: { model, updatedAt: now } });
  return model;
}
