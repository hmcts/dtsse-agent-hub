import "server-only";
import { grantsHeldBy } from "../access/load.ts";
import { canReadMessage } from "../access/rules.ts";
import { grantsGiven, grantsReceived } from "../access/views.ts";
import { agentPath } from "../agents/path.ts";
import { type AgentView, agentView, visibleAgents } from "../agents/views.ts";
import { findChannel, listChannels } from "../channels/store.ts";
import { credentialBackend } from "../credentials/backend.ts";
import { type CredentialStatus, credentialStatus, ownerRefusal } from "../credentials/store.ts";
import { type LoadedThreadMessage, loadReplies, loadThreadMessage, type ThreadMessage } from "../messages/direct-thread.ts";
import { agentPosts, channelFeed, type Match, type PostScope, recentPosts } from "../messages/feed.ts";
import { FEED_PAGE_SIZE, type FeedPageView, toPage } from "../messages/pagination.ts";
import { parseMessageRef } from "../messages/permalink.ts";
import { prisma } from "../store/prisma.ts";
import { hiddenTopicPrefix } from "../topics/slug.ts";
import { listTopics, mostActiveTopics } from "../topics/store.ts";
import { agentConversation } from "../transcripts/views.ts";
import type { Identity } from "../users/identity.ts";
import type { ModelRoute, Viewer } from "../viewer/identity.ts";
import { virtualAgentsEnabled } from "../virtual-agents/settings.ts";
import {
  type VirtualAgentCard,
  type VirtualAgentDetail,
  type VirtualAgentSummary,
  virtualAgentCards,
  virtualAgentDetail,
  virtualAgentSummary
} from "../virtual-agents/views.ts";

/**
 * The reads the pages make, in one place. `server-only` so a client component importing it fails the build rather
 * than trying to reach Postgres from a browser. Every read that depends on who is looking takes the viewer, and
 * applies `src/access/` through the stores it calls.
 */

export const SIDEBAR_TOPICS = 12;

export async function sidebarData(viewer: Identity) {
  const [agents, channels, topics] = await Promise.all([
    visibleAgents(prisma, viewer.oid),
    listChannels(prisma, viewer.oid),
    mostActiveTopics(prisma, SIDEBAR_TOPICS, hiddenTopicPrefix(""))
  ]);
  return { ...agents, channels, topics };
}

export async function feedPage(topics: PostScope, match: Match): Promise<FeedPageView> {
  const limit = FEED_PAGE_SIZE + 1;
  return toPage(topics === "everything" ? await recentPosts(prisma, { limit }) : await channelFeed(prisma, { topics, match, limit }));
}

/** Home watches the topics of the viewer's own channels, or every post when they have none. */
export async function overview(viewer: Identity) {
  const [agents, channels] = await Promise.all([visibleAgents(prisma, viewer.oid), listChannels(prisma, viewer.oid)]);
  const topics = [...new Set(channels.mine.flatMap((channel) => channel.topics))];
  const watched: PostScope = topics.length > 0 ? topics : "everything";
  return { agents, channels, topics, watched, activity: await feedPage(watched, "any") };
}

export async function channel(viewer: Identity, id: string) {
  return await findChannel(prisma, viewer.oid, id);
}

/** The rest of an agent's page, which it streams in once `agentRoute` has decided the viewer may see the agent. */
export async function agentActivity(viewer: Identity, view: AgentView) {
  const agent = { id: view.agent.id, ownerOid: view.agent.owner.oid };
  const [conversation, posts] = await Promise.all([agentConversation(prisma, viewer.oid, agent, view.grants), agentPosts(prisma, view.agent.id, 20)]);
  return { conversation, posts };
}

export async function topics(prefix: string) {
  return await listTopics(prisma, prefix, 200, hiddenTopicPrefix(prefix));
}

export async function access(viewer: Identity) {
  const [given, received] = await Promise.all([grantsGiven(prisma, viewer.oid), grantsReceived(prisma, viewer.oid)]);
  return { given, received };
}

export type CredentialSettings =
  | { available: true; modelRoute: ModelRoute; statuses: CredentialStatus[] }
  | { available: false; modelRoute: ModelRoute; reason: string };

/** What the viewer has stored, as metadata: nothing here, or anywhere the pages read, carries a credential's value. */
export async function credentialSettings(viewer: Viewer): Promise<CredentialSettings> {
  const backend = credentialBackend(prisma);
  if (!backend.available) {
    return { available: false, modelRoute: viewer.modelRoute, reason: backend.reason };
  }
  const refusal = ownerRefusal(backend.store, viewer.oid);
  if (refusal !== undefined) {
    return { available: false, modelRoute: viewer.modelRoute, reason: refusal.message };
  }
  return { available: true, modelRoute: viewer.modelRoute, statuses: await credentialStatus(prisma, viewer.oid) };
}

export interface MessagePageView {
  message: ThreadMessage;
  /** The message this one replies to, or `null` when it is not a reply or the viewer may not read the parent. */
  parent: ThreadMessage | null;
  replies: ThreadMessage[];
}

/**
 * A message with its parent and its direct replies, keeping only what `canReadMessage` lets the viewer read, or
 * `undefined` for the not-found the page answers when the id is malformed, missing or not the viewer's to read.
 */
export async function messagePage(viewer: Identity, rawId: string): Promise<MessagePageView | undefined> {
  const id = parseMessageRef(rawId);
  if (id === null) {
    return undefined;
  }
  const [loaded, grants] = await Promise.all([loadThreadMessage(prisma, id), grantsHeldBy(prisma, viewer.oid)]);
  if (loaded === undefined || !canReadMessage(viewer.oid, loaded.ref, grants)) {
    return undefined;
  }
  const inReplyTo = loaded.message.in_reply_to;
  const [parent, replies] = await Promise.all([inReplyTo === null ? undefined : loadThreadMessage(prisma, BigInt(inReplyTo)), loadReplies(prisma, id)]);
  const readable = (entry: LoadedThreadMessage | undefined): entry is LoadedThreadMessage =>
    entry !== undefined && canReadMessage(viewer.oid, entry.ref, grants);
  return {
    message: loaded.message,
    parent: readable(parent) ? parent.message : null,
    replies: replies.filter((reply) => readable(reply)).map((reply) => reply.message)
  };
}

export interface VirtualAgentsPageView {
  modelRoute: ModelRoute;
  agents: VirtualAgentCard[];
}

/** The viewer's own virtual agents. Nobody sees anyone else's. */
export async function virtualAgentsPage(viewer: Viewer): Promise<VirtualAgentsPageView> {
  return { modelRoute: viewer.modelRoute, agents: await virtualAgentCards(prisma, viewer.oid) };
}

export interface VirtualAgentPageView {
  summary: VirtualAgentSummary;
  /** Its lifecycle, settings and sign-ins, for its owner; `null` for anyone else. */
  manage: { detail: VirtualAgentDetail; credentials: CredentialSettings } | null;
  /** The agent its current session registered, once there is one. */
  linked: AgentView | null;
}

/** A virtual agent the viewer may see, or `undefined` for the not-found the page answers. */
export async function virtualAgentPage(viewer: Viewer, id: string): Promise<VirtualAgentPageView | undefined> {
  const summary = await virtualAgentSummary(prisma, viewer.oid, id);
  if (summary === undefined) {
    return undefined;
  }
  const [detail, linked] = await Promise.all([
    virtualAgentDetail(prisma, viewer.oid, id),
    summary.agentId === null ? undefined : agentView(prisma, viewer.oid, summary.agentId)
  ]);
  const manage = detail === undefined ? null : { detail, credentials: await credentialSettings(viewer) };
  return { summary, manage, linked: linked ?? null };
}

export type AgentRoute = { variant: "virtual"; page: VirtualAgentPageView } | { variant: "local"; view: AgentView } | { variant: "moved"; to: string };

/**
 * What `/agents/{id}` shows. A virtual agent's id is its page. An agent one of its sessions registered moves there,
 * since a virtual agent registers a new agent on every `/clear` and its page always shows the current one. Any other
 * agent is shown as itself. `undefined` is the not-found for an id that is none of these, or that the viewer may not
 * see.
 */
export async function agentRoute(viewer: Viewer, id: string): Promise<AgentRoute | undefined> {
  if (virtualAgentsEnabled()) {
    const page = await virtualAgentPage(viewer, id);
    if (page !== undefined) {
      return { variant: "virtual", page };
    }
  }
  const view = await agentView(prisma, viewer.oid, id);
  if (view === undefined) {
    return undefined;
  }
  return view.agent.virtualAgentId === null ? { variant: "local", view } : { variant: "moved", to: agentPath(view.agent) };
}
