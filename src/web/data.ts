import "server-only";
import { grantsGiven, grantsReceived } from "../access/views.ts";
import { agentView, visibleAgents } from "../agents/views.ts";
import { findChannel, listChannels } from "../channels/store.ts";
import { agentThread } from "../messages/direct-thread.ts";
import { agentPosts, channelFeed, type Match, recentPosts } from "../messages/feed.ts";
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

export async function feedPage(topics: readonly string[], match: Match): Promise<FeedPageView> {
  return toPage(await channelFeed(prisma, { topics, match, limit: FEED_PAGE_SIZE + 1 }));
}

export async function overview(viewer: Identity) {
  const [agents, channels] = await Promise.all([visibleAgents(prisma, viewer.oid), listChannels(prisma, viewer.oid)]);
  const topics = [...new Set(channels.mine.flatMap((channel) => channel.topics))];
  const activity = topics.length > 0 ? await feedPage(topics, "any") : { messages: await recentPosts(prisma, FEED_PAGE_SIZE), olderBefore: null };
  return { agents, channels, topics, activity };
}

export async function channel(viewer: Identity, id: string) {
  return await findChannel(prisma, viewer.oid, id);
}

export async function agentPage(viewer: Identity, id: string) {
  const view = await agentView(prisma, viewer.oid, id);
  if (view === undefined) {
    return undefined;
  }
  const [thread, posts] = await Promise.all([agentThread(prisma, viewer.oid, id, view.grants), agentPosts(prisma, id, 20)]);
  return { ...view, thread, posts };
}

export async function topics(prefix: string) {
  return await listTopics(prisma, prefix, 200);
}

export async function access(viewer: Identity) {
  const [given, received] = await Promise.all([grantsGiven(prisma, viewer.oid), grantsReceived(prisma, viewer.oid)]);
  return { given, received };
}
