import { HttpError } from "../agent-api/http.ts";
import type { Database } from "../store/prisma.ts";
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
