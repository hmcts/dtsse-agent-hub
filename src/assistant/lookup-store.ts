import { canLookUpAtlassian } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { clientSupports } from "../agents/client-features.ts";
import { isUuid } from "../agents/store.ts";
import type { EventHub } from "../realtime/hub.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { setDesired } from "../virtual-agents/store.ts";
import {
  checkResults,
  LOOKUP_RATE_LIMIT,
  LOOKUP_RATE_WINDOW_MS,
  LOOKUP_RETENTION_MS,
  type LookupAnswer,
  type LookupKind,
  type LookupResponse,
  lookupResponse
} from "./lookups.ts";
import { findAssistant } from "./store.ts";

/**
 * A lookup as the hub keeps it: recorded when the owner asks, sent to their pod on its sessions stream, answered by
 * the pod, and read back by the request that asked. See "Atlassian lookups" in docs/agent-api.md.
 */

export interface LookupQuestion {
  viewerOid: string;
  kind: LookupKind;
  query: string;
  /** A Confluence space key to narrow the search to, already checked. */
  space: string | null;
  signIn: boolean;
}

/** The lookup to wait for, or what to answer straight away because the pod cannot be asked. */
export type Asked = { lookupId: string; virtualAgentId: string } | { answer: LookupResponse };

/**
 * Records the question for the viewer's own assistant and tells its pod. A stopped assistant is started rather than
 * asked, and a pod whose client cannot answer is not sent a frame nobody would read.
 */
export async function askLookup(prisma: PrismaClient, question: LookupQuestion, now: Date = new Date()): Promise<Asked> {
  const assistant = await findAssistant(prisma, question.viewerOid);
  if (assistant === undefined || !canLookUpAtlassian(question.viewerOid, assistant)) {
    throw new HttpError(404, "you have no assistant to search with yet");
  }
  if (assistant.desired === "stopped") {
    await setDesired(prisma, question.viewerOid, assistant.id, "running", now);
    return { answer: { status: "waking" } };
  }
  if (assistant.status !== "running" || assistant.agentId === null) {
    return { answer: { status: "waking" } };
  }
  const current = await prisma.agent.findUnique({ where: { id: assistant.agentId }, select: { clientFeatures: true } });
  if (!clientSupports(current?.clientFeatures, "lookups")) {
    return { answer: { status: "unsupported" } };
  }
  const id = await prisma.$transaction(async (tx) => {
    // The assistant's rows are taken one lookup at a time, so two tabs cannot both find room under the limit.
    await tx.$queryRaw`SELECT 1 FROM virtual_agent WHERE id = ${assistant.id}::uuid FOR UPDATE`;
    await tx.assistantLookup.deleteMany({ where: { virtualAgentId: assistant.id, createdAt: { lt: new Date(now.getTime() - LOOKUP_RETENTION_MS) } } });
    const recent = await tx.assistantLookup.count({
      where: { virtualAgentId: assistant.id, createdAt: { gte: new Date(now.getTime() - LOOKUP_RATE_WINDOW_MS) } }
    });
    if (recent >= LOOKUP_RATE_LIMIT) {
      throw new HttpError(429, "that is a lot of searches at once; wait a moment and try again");
    }
    const row = await tx.assistantLookup.create({
      data: { virtualAgentId: assistant.id, kind: question.kind, query: question.query, spaceKey: question.space, signIn: question.signIn, createdAt: now },
      select: { id: true }
    });
    await notify(tx, { type: "assistant_lookup", lookup_id: row.id, virtual_agent_id: assistant.id, owner_oid: question.viewerOid });
    return row.id;
  });
  return { lookupId: id, virtualAgentId: assistant.id };
}

/** What a stored lookup answers, or `undefined` while the pod has not. A lookup that has gone answers `timeout`. */
export async function readLookup(db: Database, lookupId: string): Promise<LookupResponse | undefined> {
  const row = await db.assistantLookup.findUnique({ where: { id: lookupId }, select: { kind: true, status: true, results: true, error: true, detail: true } });
  return row === null ? { status: "timeout" } : lookupResponse(row);
}

/**
 * Waits for the pod's answer: on its NOTIFY, and on a slow poll as well, since a NOTIFY sent while this pod's listener
 * was reconnecting is gone. Subscribed before the first read, so an answer committed in between is not missed.
 */
export async function waitForLookup(
  db: Database,
  hub: EventHub,
  lookupId: string,
  { timeoutMs, pollMs = 2000, signal }: { timeoutMs: number; pollMs?: number; signal?: AbortSignal }
): Promise<LookupResponse> {
  return await new Promise<LookupResponse>((resolve) => {
    let done = false;
    let reading = false;
    let again = false;
    const finish = (answer: LookupResponse) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe();
        signal?.removeEventListener("abort", aborted);
        resolve(answer);
      }
    };
    const check = async (): Promise<void> => {
      if (done) {
        return;
      }
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const answer = await readLookup(db, lookupId);
        if (answer !== undefined) {
          finish(answer);
        }
      } catch {
        // A failed read is tried again on the next poll; the timeout bounds it.
      } finally {
        reading = false;
      }
      if (again) {
        again = false;
        await check();
      }
    };
    const aborted = () => finish({ status: "timeout" });
    const unsubscribe = hub.subscribe((event) => {
      if ((event.type === "assistant_lookup_answered" && event.lookup_id === lookupId) || event.type === "resync") {
        void check();
      }
    });
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    const poll = setInterval(() => void check(), pollMs);
    signal?.addEventListener("abort", aborted, { once: true });
    void check();
  });
}

/**
 * The pod's answer, kept only for one of its own lookups that is still unanswered, so a late or repeated answer, or one
 * for another assistant's lookup, changes nothing. Results that are not of the lookup's kind are refused.
 */
export async function answerLookup(
  prisma: PrismaClient,
  virtualAgent: { id: string; ownerOid: string },
  lookupId: string,
  answer: LookupAnswer,
  now: Date = new Date()
): Promise<void> {
  if (!isUuid(lookupId)) {
    return;
  }
  const row = await prisma.assistantLookup.findUnique({ where: { id: lookupId }, select: { virtualAgentId: true, kind: true, status: true } });
  if (row === null || row.virtualAgentId !== virtualAgent.id || row.status !== "pending") {
    return;
  }
  let data: { status: string; results?: object; error?: string; detail?: string | null; answeredAt: Date };
  if ("results" in answer) {
    const results = checkResults(row.kind as LookupKind, answer.results);
    if (results === undefined) {
      throw new HttpError(400, `those are not ${row.kind === "jira_project" ? "Jira projects" : "Confluence pages"}`);
    }
    data = { status: "done", results, answeredAt: now };
  } else {
    data = { status: "failed", error: answer.error, detail: answer.detail ?? null, answeredAt: now };
  }
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantLookup.updateMany({ where: { id: lookupId, virtualAgentId: virtualAgent.id, status: "pending" }, data });
    if (count > 0) {
      await notify(tx, { type: "assistant_lookup_answered", lookup_id: lookupId, virtual_agent_id: virtualAgent.id, owner_oid: virtualAgent.ownerOid });
    }
  });
}

/** What the sessions stream sends the pod for one lookup. */
export interface LookupFrame {
  lookup_id: string;
  kind: string;
  query: string;
  space: string | null;
  sign_in: boolean;
}

/** The frame for a lookup of this virtual agent's still waiting for an answer, or `undefined`. */
export async function pendingLookup(db: Database, virtualAgentId: string, lookupId: string): Promise<LookupFrame | undefined> {
  const row = await db.assistantLookup.findUnique({
    where: { id: lookupId },
    select: { virtualAgentId: true, kind: true, query: true, spaceKey: true, signIn: true, status: true }
  });
  if (row === null || row.virtualAgentId !== virtualAgentId || row.status !== "pending") {
    return undefined;
  }
  return { lookup_id: lookupId, kind: row.kind, query: row.query, space: row.spaceKey, sign_in: row.signIn };
}
