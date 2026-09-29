import { grantsHeldBy, loadMessageRef } from "../access/load.ts";
import { type AgentRef, canAgentMessageAgent, replyRoute } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { isUuid, resolveTargets } from "../agents/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import type { ApiMessage } from "./shape.ts";
import { createDirect, createPost } from "./store.ts";

/** What an agent sends, with the access rules applied. Refusals are `HttpError`s carrying the contract's status. */

export interface NewAgentPost {
  topics: string[];
  title: string | null;
  body: string;
  inReplyTo: bigint | null;
}

export async function postAsAgent(prisma: PrismaClient, sender: AgentRef, post: NewAgentPost): Promise<ApiMessage> {
  if (post.inReplyTo !== null) {
    const parent = await prisma.message.findUnique({ where: { id: post.inReplyTo }, select: { kind: true } });
    if (parent?.kind !== "post") {
      throw new HttpError(400, "in_reply_to must be the id of an existing post");
    }
  }
  return await createPost(prisma, { author: { oid: sender.ownerOid, agentId: sender.id }, ...post });
}

export type DirectRequest = { toAgent: string; body: string } | { replyTo: bigint; body: string };

export async function directAsAgent(prisma: PrismaClient, sender: AgentRef, request: DirectRequest): Promise<ApiMessage> {
  const author = { oid: sender.ownerOid, agentId: sender.id };
  const grants = await grantsHeldBy(prisma, sender.ownerOid);

  if ("replyTo" in request) {
    const original = await loadMessageRef(prisma, request.replyTo);
    if (original === undefined) {
      throw new HttpError(404, "no such message");
    }
    const route = replyRoute(sender, original, grants);
    if (route.to === "nobody") {
      throw new HttpError(route.status, route.reason);
    }
    return await createDirect(prisma, {
      author,
      targetAgentId: route.to === "agent" ? route.target.id : null,
      inReplyTo: original.id,
      body: request.body
    });
  }

  const candidates = await resolveTargets(prisma, sender.ownerOid, request.toAgent);
  if (candidates.length === 0) {
    throw new HttpError(404, isUuid(request.toAgent) ? "no such agent" : `no agent you may message is called "${request.toAgent}"`);
  }
  if (candidates.length > 1) {
    throw new HttpError(409, `more than one agent you may message is called "${request.toAgent}"; send its id instead`, {
      candidates: candidates.map((candidate) => ({ id: candidate.id, name: candidate.name, owner_name: candidate.ownerName }))
    });
  }
  const target = candidates[0]!;
  if (!canAgentMessageAgent(sender, target, grants)) {
    throw new HttpError(403, "you may not message that agent");
  }
  return await createDirect(prisma, { author, targetAgentId: target.id, inReplyTo: null, body: request.body });
}
