import "server-only";
import { grantsHeldBy } from "../access/load.ts";
import { canOwnerReadCredential, canReadMessage } from "../access/rules.ts";
import { grantsGiven, grantsReceived } from "../access/views.ts";
import { type AgentView, agentView, visibleAgents } from "../agents/views.ts";
import { findChannel, listChannels } from "../channels/store.ts";
import { credentialBackend } from "../credentials/backend.ts";
import { DEFAULT_CLAUDE_MD } from "../credentials/claude-md.ts";
import { type CredentialStatus, credentialStatus, ownerRefusal, readCredential } from "../credentials/store.ts";
import { type LoadedThreadMessage, loadReplies, loadThreadMessage, type ThreadMessage } from "../messages/direct-thread.ts";
import { agentPosts, channelFeed, type Match, type PostScope, recentPosts } from "../messages/feed.ts";
import { FEED_PAGE_SIZE, type FeedPageView, toPage } from "../messages/pagination.ts";
import { parseMessageRef } from "../messages/permalink.ts";
import { prisma } from "../store/prisma.ts";
import { hiddenTopicPrefix } from "../topics/slug.ts";
import { listTopics, mostActiveTopics } from "../topics/store.ts";
import type { ConversationPage } from "../transcripts/conversation.ts";
import { agentConversation } from "../transcripts/views.ts";
import type { Identity } from "../users/identity.ts";
import type { ModelRoute, Viewer } from "../viewer/identity.ts";
import { type VirtualAgentCard, type VirtualAgentDetail, virtualAgentCards, virtualAgentDetail } from "../virtual-agents/views.ts";

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

/** The agent and the viewer's access to it, or `undefined` for the not-found the page answers. */
export async function agentPage(viewer: Identity, id: string): Promise<AgentView | undefined> {
  return await agentView(prisma, viewer.oid, id);
}

/** The rest of an agent's page, which it streams in once `agentPage` has decided the viewer may see the agent. */
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

/**
 * What the viewer has stored, as metadata: nothing here carries a credential's value. Their CLAUDE.md is not among
 * them; `claudeMdSettings` reads it for its own section.
 */
export async function credentialSettings(viewer: Viewer): Promise<CredentialSettings> {
  const backend = credentialBackend(prisma);
  if (!backend.available) {
    return { available: false, modelRoute: viewer.modelRoute, reason: backend.reason };
  }
  const refusal = ownerRefusal(backend.store, viewer.oid);
  if (refusal !== undefined) {
    return { available: false, modelRoute: viewer.modelRoute, reason: refusal.message };
  }
  const statuses = await credentialStatus(prisma, viewer.oid);
  return { available: true, modelRoute: viewer.modelRoute, statuses: statuses.filter((status) => status.kind !== "claude_md") };
}

export type ClaudeMdSettings = { available: true; stored: boolean; text: string; updatedAt: string | null } | { available: false; reason: string };

/** The viewer's own CLAUDE.md for editing, which `canOwnerReadCredential` lets them read back, or the default. */
export async function claudeMdSettings(viewer: Identity): Promise<ClaudeMdSettings> {
  const backend = credentialBackend(prisma);
  if (!backend.available) {
    return { available: false, reason: backend.reason };
  }
  const refusal = ownerRefusal(backend.store, viewer.oid);
  if (refusal !== undefined || !canOwnerReadCredential("claude_md")) {
    return { available: false, reason: refusal?.message ?? "your CLAUDE.md cannot be shown" };
  }
  const [stored, status] = await Promise.all([
    readCredential(prisma, backend.store, viewer.oid, "claude_md"),
    prisma.credential.findUnique({ where: { ownerOid_kind: { ownerOid: viewer.oid, kind: "claude_md" } }, select: { updatedAt: true } })
  ]);
  return {
    available: true,
    stored: stored !== undefined,
    text: stored ?? DEFAULT_CLAUDE_MD,
    updatedAt: stored === undefined ? null : (status?.updatedAt.toISOString() ?? null)
  };
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
  detail: VirtualAgentDetail;
  credentials: CredentialSettings;
  /** The agent its current session registered, with its conversation, once there is one. */
  linked: { view: AgentView; conversation: ConversationPage } | null;
}

/** One of the viewer's own virtual agents, or `undefined` for the not-found the page answers. */
export async function virtualAgentPage(viewer: Viewer, id: string): Promise<VirtualAgentPageView | undefined> {
  const detail = await virtualAgentDetail(prisma, viewer.oid, id);
  if (detail === undefined) {
    return undefined;
  }
  const agentId = detail.card.agentId;
  const [credentials, view] = await Promise.all([credentialSettings(viewer), agentId === null ? undefined : agentView(prisma, viewer.oid, agentId)]);
  if (view === undefined) {
    return { detail, credentials, linked: null };
  }
  const conversation = await agentConversation(prisma, viewer.oid, { id: view.agent.id, ownerOid: view.agent.owner.oid }, view.grants);
  return { detail, credentials, linked: { view, conversation } };
}
