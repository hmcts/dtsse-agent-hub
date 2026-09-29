import "server-only";
import { grantsGiven, grantsReceived } from "../access/views.ts";
import { type AgentView, agentView, visibleAgents } from "../agents/views.ts";
import { findChannel, listChannels } from "../channels/store.ts";
import { agentThread } from "../messages/direct-thread.ts";
import { agentPosts, channelFeed, type Match, type PostScope, recentPosts } from "../messages/feed.ts";
import { FEED_PAGE_SIZE, type FeedPageView, toPage } from "../messages/pagination.ts";
import { prisma } from "../store/prisma.ts";
import { listTopics, mostActiveTopics } from "../topics/store.ts";
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
    mostActiveTopics(prisma, SIDEBAR_TOPICS)
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
  const [thread, posts] = await Promise.all([agentThread(prisma, viewer.oid, view.agent.id, view.grants), agentPosts(prisma, view.agent.id, 20)]);
  return { thread, posts };
}

export async function topics(prefix: string) {
  return await listTopics(prisma, prefix, 200);
}

export async function access(viewer: Identity) {
  const [given, received] = await Promise.all([grantsGiven(prisma, viewer.oid), grantsReceived(prisma, viewer.oid)]);
  return { given, received };
}
