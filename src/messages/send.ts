import { grantsHeldBy, loadMessageRef } from "../access/load.ts";
import { type AgentRef, canAgentMessageAgent, canPersonMessageAgent, canViewAgent, replyRoute, tagRefusal } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { type Candidate, findAgent, isUuid, resolveTargets } from "../agents/store.ts";
import type { PrismaClient } from "../store/prisma.ts";
import type { ApiMessage } from "./shape.ts";
import { type Author, createDirect, createPost, type NewDirect } from "./store.ts";

/**
 * What an agent or a person sends, with the access rules applied. Refusals are `HttpError`s carrying the contract's
 * status; the web UI shows their message.
 */

export interface NewTopicPost {
  topics: string[];
  title: string | null;
  body: string;
  inReplyTo: bigint | null;
  /** Agent ids or names, already shaped and capped by `postTags`. Resolved by `taggedAgents` below; absent tags none. */
  tags?: string[];
}

/** One of the same-named agents a `409` offers, so the caller can resend with an id. */
function candidateView(candidate: Candidate): Record<string, unknown> {
  return {
    id: candidate.id,
    name: candidate.name,
    status: candidate.status,
    repo: candidate.repo,
    branch: candidate.branch,
    last_heartbeat_at: candidate.lastHeartbeatAt.toISOString(),
    owner_name: candidate.ownerName
  };
}

/**
 * The agents a post's `tag_agents` names, as ids. Each reference resolves as `to_agent` does, but among every agent
 * rather than the ones the author may message: tagging needs no grant, and `tagRefusal` is where that is said.
 *
 * Every reference is resolved before the post is written, and one that cannot be is a refusal of the whole post:
 * a post that reached some of the agents it named and dropped the rest would read as having reached all of them.
 */
async function taggedAgents(prisma: PrismaClient, author: Author, tags: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const tag of tags) {
    const candidates = await resolveTargets(prisma, author.oid, tag, "tag");
    if (candidates.length > 1) {
      throw new HttpError(409, `more than one agent is called "${tag}"; tag its id instead`, { candidates: candidates.map(candidateView) });
    }
    const target = candidates[0];
    // A pod conversation's agent is reported as missing rather than forbidden, so the refusal does not confirm it
    // exists, which is how every other rule answers for one.
    if (target === undefined || tagRefusal(author.agentId, target) === "not_taggable") {
      throw new HttpError(404, isUuid(tag) ? "no such agent" : `no agent is called "${tag}"`);
    }
    if (tagRefusal(author.agentId, target) === "itself") {
      throw new HttpError(400, "an agent cannot tag itself in its own post");
    }
    if (!ids.includes(target.id)) {
      ids.push(target.id);
    }
  }
  return ids;
}

/** A post by an agent (`author.agentId` set) or by a person from the UI (`author.agentId` null). */
export async function postAs(prisma: PrismaClient, author: Author, post: NewTopicPost): Promise<ApiMessage> {
  if (post.inReplyTo !== null) {
    const parent = await prisma.message.findUnique({ where: { id: post.inReplyTo }, select: { kind: true } });
    if (parent?.kind !== "post") {
      throw new HttpError(400, "in_reply_to must be the id of an existing post");
    }
  }
  const { tags, ...rest } = post;
  return await createPost(prisma, { author, ...rest, taggedAgentIds: await taggedAgents(prisma, author, tags ?? []) });
}

export async function postAsAgent(prisma: PrismaClient, sender: AgentRef, post: NewTopicPost): Promise<ApiMessage> {
  return await postAs(prisma, { oid: sender.ownerOid, agentId: sender.id }, post);
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
      candidates: candidates.map(candidateView)
    });
  }
  const target = candidates[0]!;
  if (!canAgentMessageAgent(sender, target, grants)) {
    throw new HttpError(403, "you may not message that agent");
  }
  return await createDirect(prisma, { author, targetAgentId: target.id, inReplyTo: null, body: request.body });
}

/**
 * A person's direct message to an agent from its page in the UI. The same write as an agent's, so it queues a
 * delivery the agent's stream sends and NOTIFYs every pod. An agent the sender cannot see is reported as missing,
 * not forbidden, so the refusal does not confirm that it exists.
 */
/** `alongside` is `NewDirect`'s: work that shares the message's transaction, which the Assistant attaches files in. */
export async function directAsPerson(
  prisma: PrismaClient,
  senderOid: string,
  agentId: string,
  body: string,
  alongside?: NewDirect["alongside"]
): Promise<ApiMessage> {
  const target = isUuid(agentId) ? await findAgent(prisma, agentId) : undefined;
  const grants = await grantsHeldBy(prisma, senderOid);
  if (target === undefined || !canViewAgent(senderOid, target, grants)) {
    throw new HttpError(404, "no such agent");
  }
  if (!canPersonMessageAgent(senderOid, target, grants)) {
    throw new HttpError(403, "you have read access to this agent, not write access");
  }
  return await createDirect(prisma, { author: { oid: senderOid, agentId: null }, targetAgentId: target.id, inReplyTo: null, body, alongside });
}
