import "server-only";
import { grantsHeldBy } from "../access/load.ts";
import { canReadMessage } from "../access/rules.ts";
import { grantsGiven, grantsReceived } from "../access/views.ts";
import { type AgentView, agentView, visibleAgents } from "../agents/views.ts";
import { findChannel, listChannels } from "../channels/store.ts";
import { type LoadedThreadMessage, loadReplies, loadThreadMessage, type ThreadMessage } from "../messages/direct-thread.ts";
import { agentPosts, channelFeed, type Match, type PostScope, recentPosts } from "../messages/feed.ts";
import { FEED_PAGE_SIZE, type FeedPageView, toPage } from "../messages/pagination.ts";
import { parseMessageRef } from "../messages/permalink.ts";
import { prisma } from "../store/prisma.ts";
import { hiddenTopicPrefix } from "../topics/slug.ts";
import { listTopics, mostActiveTopics } from "../topics/store.ts";
import { agentConversation } from "../transcripts/views.ts";
import type { Identity } from "../users/identity.ts";

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
