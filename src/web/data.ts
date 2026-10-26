import "server-only";
import { grantsHeldBy } from "../access/load.ts";
import { canManageConversationShares, canOwnerReadCredential, canReadMessage } from "../access/rules.ts";
import { grantsGiven, grantsReceived } from "../access/views.ts";
import { agentPath } from "../agents/path.ts";
import { type AgentView, agentView, visibleAgents } from "../agents/views.ts";
import type { DateGroup } from "../assistant/grouping.ts";
import {
  accessToConversation,
  conversationRef,
  conversationsSharedBy,
  conversationsSharedWith,
  type SharedChatLink,
  type SharePerson,
  shareRecipients
} from "../assistant/shares.ts";
import { type SharedConversationView, sharedConversation } from "../assistant/sharing.ts";
import { conversationAgent, ensureAssistant, findConversation } from "../assistant/store.ts";
import { listTemplates } from "../assistant/template-store.ts";
import type { SavedTemplate } from "../assistant/templates.ts";
import {
  type AssistantSummary,
  assistantSummary,
  type ConversationLink,
  type ConversationView,
  conversationGroups,
  conversationLinks,
  conversationView,
  type UnsentChat,
  unsentChat
} from "../assistant/views.ts";
import { findChannel, listChannels } from "../channels/store.ts";
import { credentialBackend } from "../credentials/backend.ts";
import { DEFAULT_CLAUDE_MD } from "../credentials/claude-md.ts";
import { type GitIdentity, readGitIdentity } from "../credentials/git-identity.ts";
import type { CredentialKind } from "../credentials/names.ts";
import { type CredentialStatus, credentialStatus, ownerRefusal, readCredential } from "../credentials/store.ts";
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
import { availablePlugins, PluginConfigurationError, type PluginOffer, type PluginOption } from "../virtual-agents/plugins.ts";
import { virtualAgentsEnabled } from "../virtual-agents/settings.ts";
import { liveModelRoutes } from "../virtual-agents/store.ts";
import {
  claudeTokenUsable,
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

export type CredentialSettings = { modelRoute: ModelRoute; claudeTokenUsable: boolean } & (
  | { available: true; statuses: CredentialStatus[] }
  | { available: false; reason: string }
);

/**
 * What the viewer has stored, as metadata: nothing here carries a credential's value. Their CLAUDE.md and git identity
 * are not among them; `claudeMdSettings` and `gitIdentitySettings` read those for their own forms.
 *
 * `modelRoute` is the viewer's own, which is what a new agent of theirs would be created on; `claudeTokenUsable`
 * answers the one question that route is not enough for, because it is the agents' routes that decide whether a
 * Claude token is any use.
 */
export async function credentialSettings(viewer: Viewer): Promise<CredentialSettings> {
  const route = { modelRoute: viewer.modelRoute, claudeTokenUsable: claudeTokenUsable(viewer.modelRoute, await liveModelRoutes(prisma, viewer.oid)) };
  const backend = credentialBackend(prisma);
  if (!backend.available) {
    return { ...route, available: false, reason: backend.reason };
  }
  const refusal = ownerRefusal(backend.store, viewer.oid);
  if (refusal !== undefined) {
    return { ...route, available: false, reason: refusal.message };
  }
  const statuses = await credentialStatus(prisma, viewer.oid);
  return {
    ...route,
    available: true,
    statuses: statuses.filter((status) => status.kind !== "claude_md" && status.kind !== "git_identity")
  };
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

export type GitIdentitySettings = { available: true; stored: boolean; identity: GitIdentity } | { available: false; reason: string };

/** The viewer's own git identity override for editing, which `canOwnerReadCredential` lets them read back. */
export async function gitIdentitySettings(viewer: Identity): Promise<GitIdentitySettings> {
  const backend = credentialBackend(prisma);
  if (!backend.available) {
    return { available: false, reason: backend.reason };
  }
  const refusal = ownerRefusal(backend.store, viewer.oid);
  if (refusal !== undefined || !canOwnerReadCredential("git_identity")) {
    return { available: false, reason: refusal?.message ?? "your git identity cannot be shown" };
  }
  const stored = await readCredential(prisma, backend.store, viewer.oid, "git_identity");
  return { available: true, stored: stored !== undefined, identity: readGitIdentity(stored) };
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
  manage: { detail: VirtualAgentDetail; credentials: CredentialSettings; chats: ConversationLink[] } | null;
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
  const manage =
    detail === undefined ? null : { detail, credentials: await credentialSettings(viewer), chats: await conversationLinks(prisma, viewer.oid, detail.card.id) };
  return { summary, manage, linked: linked ?? null };
}

export type AgentRoute = { variant: "virtual"; page: VirtualAgentPageView } | { variant: "local"; view: AgentView } | { variant: "moved"; to: string };

/**
 * What `/hub/agents/{id}` shows. A virtual agent's id is its page. An agent one of its sessions registered moves there,
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
  if (view.agent.virtualAgentId === null) {
    return { variant: "local", view };
  }
  // A conversation's agent is a chat in the HMCTS Assistant, and is shown there rather than as a session.
  const agent = await prisma.agent.findUnique({ where: { id: view.agent.id }, select: { assistantConversationId: true } });
  const conversationId = agent?.assistantConversationId ?? null;
  return { variant: "moved", to: conversationId === null ? agentPath(view.agent) : `/assistant/${conversationId}` };
}

export interface AssistantHome {
  assistant: AssistantSummary;
  credentials: CredentialSettings;
  conversations: { label: DateGroup; items: ConversationLink[] }[];
  /**
   * The workspace plugins this hub offers, and the ones the viewer's assistant loads; `null` when the configuration
   * cannot be read, which is not the same as its offering nothing.
   */
  plugins: { available: PluginOption[]; checked: string[] } | null;
}

function storedKinds(credentials: CredentialSettings): Set<CredentialKind> {
  return new Set(credentials.available ? credentials.statuses.filter((status) => status.stored).map((status) => status.kind) : []);
}

/**
 * `VIRTUAL_AGENT_PLUGINS` as a plugin form can use it: its options, or the reason it is unreadable. The one catch a
 * malformed configuration gets, which every surface that offers plugins reads through, so none of them can let it
 * throw out through a page.
 *
 * What a surface then does with an unreadable configuration differs, and the asymmetry is deliberate. The hub's own
 * plugin surfaces, `/hub/virtual` and `/hub/agents/{id}`, name the variable and the fault in place of the plugin
 * form, because the person reading them is the person who can fix it, and that now costs the plugin form alone
 * rather than the whole page. The Assistant says nothing and hides the section, because it is someone's whole chat
 * surface and a configuration they can neither see nor fix must not put a hub error in front of their chats.
 *
 * Neither may answer an unreadable configuration with an empty offer. "The hub offers none" is a state a person can
 * trust and act on; "the configuration cannot be read" is not, and silently merging the two would show every plugin
 * an agent already loads as one the hub no longer offers.
 */
export function pluginOffer(): PluginOffer {
  try {
    return { ok: true, available: availablePlugins() };
  } catch (error) {
    if (error instanceof PluginConfigurationError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

function pluginSettings(assistant: { plugins: string[] }): AssistantHome["plugins"] {
  const offer = pluginOffer();
  return offer.ok ? { available: [...offer.available], checked: assistant.plugins } : null;
}

/**
 * Opening the Assistant: the viewer's assistant, created on their first visit and started if it has stopped, so it is
 * warming up while they sign in or type; what it still needs from them; and their conversations.
 */
export async function openAssistant(viewer: Viewer): Promise<AssistantHome> {
  const assistant = await ensureAssistant(prisma, viewer);
  const [credentials, conversations] = await Promise.all([credentialSettings(viewer), conversationGroups(prisma, viewer.oid)]);
  return {
    assistant: await assistantSummary(prisma, assistant, storedKinds(credentials)),
    credentials,
    conversations,
    plugins: pluginSettings(assistant)
  };
}

/**
 * The new chat the viewer already opened for a file and never sent, for `/assistant` to hand back to that screen.
 * Its own read rather than part of `openAssistant`, because every other page that renders the sidebar has no use for
 * it and should not pay for the query.
 */
export async function unsentNewChat(viewer: Viewer): Promise<UnsentChat | undefined> {
  return await unsentChat(prisma, viewer.oid);
}

/**
 * The viewer's own saved prompts, for the settings dialog to edit and both composers to offer.
 *
 * Its own read rather than part of `openAssistant` so the one place that decides whose templates these are is the
 * store, which asks `canManageTemplate` with the viewer as both the actor and the owner.
 */
export async function assistantTemplates(viewer: Identity): Promise<SavedTemplate[]> {
  return await listTemplates(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid });
}

/** One of the viewer's conversations, or `undefined` for the not-found the page answers. */
export async function assistantConversation(viewer: Viewer, id: string): Promise<ConversationView | undefined> {
  const conversation = await findConversation(prisma, viewer.oid, id);
  if (conversation === undefined) {
    return undefined;
  }
  return await conversationView(prisma, conversation, await conversationAgent(prisma, conversation));
}

/**
 * The read-only share of a conversation, for its owner or for someone they named, and `undefined` for everyone else
 * — including someone who was handed the link, since the link is how a recipient reaches a share and never what
 * grants one. `accessToConversation` applies `canViewSharedConversation`.
 */
export async function sharedChat(viewer: Identity, id: string): Promise<SharedConversationView | undefined> {
  const allowed = await accessToConversation(prisma, viewer.oid, id);
  if (allowed === undefined) {
    return undefined;
  }
  return await sharedConversation(prisma, allowed.conversation, allowed.access);
}

/** Who one of the viewer's own conversations is shared with, or `undefined` when it is not theirs to share. */
export async function chatShares(viewer: Identity, id: string): Promise<SharePerson[] | undefined> {
  const conversation = await conversationRef(prisma, id);
  if (conversation === undefined || !canManageConversationShares(viewer.oid, conversation)) {
    return undefined;
  }
  return await shareRecipients(prisma, id);
}

/** Both sides of the viewer's shares: their own chats they have shared, and the chats shared with them. */
export async function sharedChats(viewer: Identity): Promise<{ given: SharedChatLink[]; received: SharedChatLink[] }> {
  const [given, received] = await Promise.all([conversationsSharedBy(prisma, viewer.oid), conversationsSharedWith(prisma, viewer.oid)]);
  return { given, received };
}
