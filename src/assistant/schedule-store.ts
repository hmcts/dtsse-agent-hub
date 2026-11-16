import { HttpError } from "../agent-api/http.ts";
import type { Database } from "../store/prisma.ts";
import { DEFAULT_IDLE, isAutoStartTime, isIdleAfter, NO_AUTO_START } from "../virtual-agents/schedule.ts";
import { eveningStop } from "../virtual-agents/settings.ts";

/**
 * The person's schedule for their virtual agents, stored as one row. The `owner_oid` in each query is what makes
 * another person's unreachable. What the choices mean is `src/virtual-agents/schedule.ts`'s, and what the sweep does
 * with them is `sweep.ts`'s.
 */

/** What is stored: `null` is none, and for the idle period the deployment's own. A time the evening stop no longer leaves room for reads as none. */
export interface AssistantSchedule {
  autoStartTime: string | null;
  idleAfter: string | null;
}

export async function readAssistantSchedule(db: Database, ownerOid: string): Promise<AssistantSchedule> {
  const row = await db.assistantSchedule.findUnique({ where: { ownerOid }, select: { autoStartTime: true, idleAfter: true } });
  return {
    autoStartTime: isAutoStartTime(row?.autoStartTime, eveningStop()) ? row.autoStartTime : null,
    idleAfter: isIdleAfter(row?.idleAfter) ? row.idleAfter : null
  };
}

/**
 * Replaces both settings, and answers them as stored. Refused for anything but a slot the form offers for the evening stop and an idle
 * period it offers. The day of the last auto start is left alone, so changing the time never starts an agent twice in
 * a day.
 */
export async function saveAssistantSchedule(
  db: Database,
  ownerOid: string,
  input: { autoStart: unknown; idleAfter: unknown },
  now: Date = new Date()
): Promise<AssistantSchedule> {
  const stop = eveningStop();
  if (input.autoStart !== NO_AUTO_START && !isAutoStartTime(input.autoStart, stop)) {
    throw new HttpError(400, "pick an auto start time from the list");
  }
  if (input.idleAfter !== DEFAULT_IDLE && !isIdleAfter(input.idleAfter)) {
    throw new HttpError(400, "pick how long to wait before shutting down from the list");
  }
  const autoStartTime = isAutoStartTime(input.autoStart, stop) ? input.autoStart : null;
  const idleAfter = isIdleAfter(input.idleAfter) ? input.idleAfter : null;
  await db.assistantSchedule.upsert({
    where: { ownerOid },
    create: { ownerOid, autoStartTime, idleAfter, updatedAt: now },
    update: { autoStartTime, idleAfter, updatedAt: now }
  });
  return { autoStartTime, idleAfter };
}
