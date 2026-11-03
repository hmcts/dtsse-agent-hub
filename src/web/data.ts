import "server-only";
import { canManageVirtualAgent, canOwnerReadCredential, canReadDeck, canReadMessage, isOwner } from "../access/rules.ts";
import { isUuid } from "../agents/store.ts";
import { ensureAssistant, findAssistant } from "../assistant/assistant-store.ts";
import { conversationAgent, findConversation } from "../assistant/conversation-store.ts";
import { isSha256 } from "../assistant/deck.ts";
import { type DeckAsset, type DeckView, deckView, readDeckAsset, readDeckPptx } from "../assistant/deck-store.ts";
import { readExportDefaults } from "../assistant/export-default-store.ts";
import type { ExportDefaults } from "../assistant/export-defaults.ts";
import { conversationsForkableBy, conversationsOfferedBy, forkChoice, forkRecipients } from "../assistant/fork-store.ts";
import type { DateGroup } from "../assistant/grouping.ts";
import { type AssistantMemory, assistantMemory } from "../assistant/memory.ts";
import { type AssistantModelChoice, assistantModelChoice } from "../assistant/model-store.ts";
import { type ChatGate, chatCredentials, chatGate } from "../assistant/onboarding.ts";
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
import { listTemplates } from "../assistant/template-store.ts";
import type { SavedTemplate } from "../assistant/templates.ts";
import { type UploadsOnDisk, uploadsOnDisk } from "../assistant/upload-disk.ts";
import {
  type AssistantSummary,
  assistantSummary,
  type ConversationLink,
  type ConversationView,
  conversationGroups,
  conversationView,
  type UnsentChat,
  unsentChat
} from "../assistant/views.ts";
import { hasWelshPlugin } from "../assistant/welsh.ts";
import { findChannel, listChannels } from "../channels/store.ts";
import { credentialBackend } from "../credentials/backend.ts";
import { DEFAULT_CLAUDE_MD } from "../credentials/claude-md.ts";
import { type GitIdentity, readGitIdentity } from "../credentials/git-identity.ts";
import type { CredentialKind } from "../credentials/names.ts";
import { type CredentialStatus, credentialStatus, ownerRefusal, readCredential } from "../credentials/store.ts";
import { type LoadedThreadMessage, loadReplies, loadThreadMessage, type ThreadMessage } from "../messages/direct-thread.ts";
import { channelFeed, type Match, type PostScope, recentPosts } from "../messages/feed.ts";
import { FEED_PAGE_SIZE, type FeedPageView, toPage } from "../messages/pagination.ts";
import { parseMessageRef } from "../messages/permalink.ts";
import { prisma } from "../store/prisma.ts";
import { hiddenTopicPrefix } from "../topics/slug.ts";
import { listTopics, mostActiveTopics } from "../topics/store.ts";
import type { Identity } from "../users/identity.ts";
import type { ModelRoute, Viewer } from "../viewer/identity.ts";
import { availablePlugins, PluginConfigurationError, type PluginOffer, type PluginOption } from "../virtual-agents/plugins.ts";
import { liveModelRoutes, type VirtualAgentRow } from "../virtual-agents/store.ts";
import { claudeTokenUsable, neededCredentials, type PortLink, portLinks } from "../virtual-agents/views.ts";
import { type AgentAddress, NO_AGENT } from "./home.ts";

/**
 * The reads the pages make, in one place. `server-only` so a client component importing it fails the build rather
 * than trying to reach Postgres from a browser. Every read that depends on who is looking takes the viewer, and
 * applies `src/access/` through the stores it calls.
 */

const SIDEBAR_TOPICS = 12;

export async function sidebarData(viewer: Identity) {
  const [channels, topics] = await Promise.all([listChannels(prisma, viewer.oid), mostActiveTopics(prisma, SIDEBAR_TOPICS, hiddenTopicPrefix(""))]);
  return { channels, topics };
}

export async function feedPage(topics: PostScope, match: Match): Promise<FeedPageView> {
  const limit = FEED_PAGE_SIZE + 1;
  return toPage(topics === "everything" ? await recentPosts(prisma, { limit }) : await channelFeed(prisma, { topics, match, limit }));
}

/** Home watches the topics of the viewer's own channels, or every post when they have none. */
export async function overview(viewer: Identity) {
  const channels = await listChannels(prisma, viewer.oid);
  const topics = [...new Set(channels.mine.flatMap((channel) => channel.topics))];
  const watched: PostScope = topics.length > 0 ? topics : "everything";
  return { topics, watched, activity: await feedPage(watched, "any") };
}

export async function channel(viewer: Identity, id: string) {
  return await findChannel(prisma, viewer.oid, id);
}

export async function topics(prefix: string) {
  return await listTopics(prisma, prefix, 200, hiddenTopicPrefix(prefix));
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
  const loaded = await loadThreadMessage(prisma, id);
  if (loaded === undefined || !canReadMessage(viewer.oid, loaded.ref)) {
    return undefined;
  }
  const inReplyTo = loaded.message.in_reply_to;
  const [parent, replies] = await Promise.all([inReplyTo === null ? undefined : loadThreadMessage(prisma, BigInt(inReplyTo)), loadReplies(prisma, id)]);
  const readable = (entry: LoadedThreadMessage | undefined): entry is LoadedThreadMessage => entry !== undefined && canReadMessage(viewer.oid, entry.ref);
  return {
    message: loaded.message,
    parent: readable(parent) ? parent.message : null,
    replies: replies.filter((reply) => readable(reply)).map((reply) => reply.message)
  };
}

/**
 * What `/hub/agents/{id}` names for the viewer, for `retiredAgentPath` to send them on from. Only their own agents and
 * virtual agents are told apart from nothing, as `isOwner` decides.
 */
export async function agentAddress(viewer: Identity, id: string): Promise<AgentAddress> {
  if (!isUuid(id)) {
    return NO_AGENT;
  }
  const [virtualAgent, agent] = await Promise.all([
    prisma.virtualAgent.findUnique({ where: { id }, select: { id: true, ownerOid: true } }),
    prisma.agent.findUnique({ where: { id }, select: { id: true, ownerOid: true, virtualAgentId: true, assistantConversationId: true } })
  ]);
  if (virtualAgent !== null && isOwner(viewer.oid, virtualAgent)) {
    return await virtualAddress(viewer, virtualAgent.id);
  }
  if (agent === null || !isOwner(viewer.oid, agent)) {
    return NO_AGENT;
  }
  if (agent.assistantConversationId !== null) {
    return { kind: "chat", conversationId: agent.assistantConversationId };
  }
  return agent.virtualAgentId === null ? NO_AGENT : await virtualAddress(viewer, agent.virtualAgentId);
}

/**
 * A virtual agent of the viewer's, and whether it is the one their Assistant runs on: only that one is what the
 * Assistant's settings show and restart, so only its address may be sent there.
 */
async function virtualAddress(viewer: Identity, virtualAgentId: string): Promise<AgentAddress> {
  return { kind: "virtual", assistant: (await findAssistant(prisma, viewer.oid))?.id === virtualAgentId };
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
  /** Its assistant has the Welsh plugin ticked, so the sidebar offers the Welsh page; read from the row, not the offer. */
  welsh: boolean;
  /** Whether the page may render the chat, or only the getting-ready screen; see `chatGate`. */
  chat: ChatGate;
}

function storedKinds(credentials: CredentialSettings): Set<CredentialKind> {
  return new Set(credentials.available ? credentials.statuses.filter((status) => status.stored).map((status) => status.kind) : []);
}

function chatGateOf(toChat: readonly CredentialKind[], credentials: CredentialSettings): ChatGate {
  return chatGate(toChat, storedKinds(credentials), credentials.available ? null : credentials.reason);
}

/**
 * `VIRTUAL_AGENT_PLUGINS` as a plugin form can use it: its options, or the reason it is unreadable. The one catch a
 * malformed configuration gets, which every surface that offers plugins reads through, so none of them can let it
 * throw out through a page.
 *
 * The Assistant, the one surface that offers plugins, says nothing about an unreadable configuration and hides the
 * section, because it is someone's whole chat surface and a configuration they can neither see nor fix must not put a
 * hub error in front of their chats.
 *
 * Nor may it answer an unreadable configuration with an empty offer. "The hub offers none" is a state a person can
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
  const summary = await assistantSummary(prisma, assistant, storedKinds(credentials));
  return {
    assistant: summary,
    credentials,
    conversations,
    plugins: pluginSettings(assistant),
    welsh: hasWelshPlugin(assistant),
    chat: chatGateOf(summary.toChat, credentials)
  };
}

/**
 * Whether the viewer may chat yet, for the server actions that start, open, warm or send to a conversation: the same
 * `chatGate` the pages render from, read again here because a page loaded before a credential was deleted, or a
 * request made without the page at all, must not get past what the page would have stopped.
 *
 * Read without `ensureAssistant`, since an action has no business creating an assistant. Someone with none yet is
 * judged on their own route, which is the route the one `openAssistant` makes them would be on.
 */
export async function assistantChatGate(viewer: Viewer): Promise<ChatGate> {
  const [assistant, credentials] = await Promise.all([findAssistant(prisma, viewer.oid), credentialSettings(viewer)]);
  const route = assistant?.modelRoute ?? viewer.modelRoute;
  return chatGateOf(chatCredentials(neededCredentials(route), route), credentials);
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
 * What the viewer's assistant holds on its own volume, for the settings dialog's Files section. `undefined` when
 * they have no assistant at all, which is the one case the section is not offered.
 *
 * Its own read rather than part of `openAssistant`, because only the settings dialog uses it and it costs a second
 * query over the viewer's uploads. The owner check is the store's, through `isOwner`.
 */
export async function assistantFiles(viewer: Viewer): Promise<UploadsOnDisk | undefined> {
  const assistant = await findAssistant(prisma, viewer.oid);
  return assistant === undefined ? undefined : await uploadsOnDisk(prisma, viewer.oid, assistant.id);
}

/** Whether the viewer's assistant has the Welsh plugin ticked, which is what the Welsh page needs to run anything. */
export async function assistantHasWelsh(viewer: Identity): Promise<boolean> {
  const assistant = await findAssistant(prisma, viewer.oid);
  return assistant !== undefined && hasWelshPlugin(assistant);
}

/**
 * How much the viewer's assistant has to work with, for the settings dialog's Size section: its size, what its pod
 * reports about its memory, and how many chats have a session on it. `undefined` when they have no assistant at all,
 * which is the one case the section is not offered.
 *
 * Its own read rather than part of `openAssistant`, as the files are: only the settings dialog uses it, and it costs a
 * second query over the viewer's conversations. The owner check is the store's, through `isOwner`.
 */
export async function assistantSize(viewer: Viewer): Promise<AssistantMemory | undefined> {
  const assistant = await findAssistant(prisma, viewer.oid);
  return assistant === undefined ? undefined : await assistantMemory(prisma, viewer.oid, assistant.id);
}

/**
 * The viewer's own saved prompts, for the settings dialog to edit and both composers to offer.
 *
 * Its own read rather than part of `openAssistant` so the one place that decides whose templates these are is the
 * store, which asks `isOwner` with the viewer as both the actor and the owner.
 */
export async function assistantTemplates(viewer: Identity): Promise<SavedTemplate[]> {
  return await listTemplates(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid });
}

/** What the settings show and manage of the virtual agent the viewer's Assistant runs on. */
export type AssistantAgent = Pick<VirtualAgentRow, "id" | "name" | "desired" | "status" | "statusDetail"> & {
  exposedPorts: PortLink[];
  localOnlyPorts: number[];
};

/**
 * The viewer's assistant as its settings manage it: its name and where it stands, and the web servers its pod
 * reports. `undefined` when they have no assistant at all. Read when the settings' Assistant or Web servers section
 * opens, from the one row `findAssistant` reads.
 */
export async function assistantAgent(viewer: Viewer): Promise<AssistantAgent | undefined> {
  const row = await findAssistant(prisma, viewer.oid);
  if (row === undefined || !canManageVirtualAgent(viewer.oid, row)) {
    return undefined;
  }
  return { id: row.id, name: row.name, desired: row.desired, status: row.status, statusDetail: row.statusDetail, ...portLinks(row) };
}

/**
 * The Claude model the viewer's chats run on, for the settings to show and change, with whether their assistant's pod
 * can act on a choice yet. `undefined` when they have no assistant at all, which is the one case the section is not
 * offered — as the Files and Size sections are not.
 */
export async function assistantModel(viewer: Viewer): Promise<AssistantModelChoice | undefined> {
  const assistant = await findAssistant(prisma, viewer.oid);
  return assistant === undefined ? undefined : await assistantModelChoice(prisma, viewer.oid, assistant.id);
}

/** Where the viewer's documents go by default, for the settings to edit and the document panel to start from. */
export async function assistantExportDefaults(viewer: Identity): Promise<ExportDefaults> {
  return await readExportDefaults(prisma, { actorOid: viewer.oid, ownerOid: viewer.oid });
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
 * grants one. `accessToConversation` applies `conversationAccess`.
 */
export async function sharedChat(viewer: Identity, id: string): Promise<SharedConversationView | undefined> {
  const allowed = await accessToConversation(prisma, viewer.oid, id);
  if (allowed === undefined) {
    return undefined;
  }
  return await sharedConversation(prisma, allowed.conversation, allowed.access, await forkChoice(prisma, viewer.oid, allowed.conversation, allowed.forks));
}

/** Whether the viewer may read the conversation's deck: its owner, or someone it is shared with or offered to. */
async function deckReadable(viewer: Identity, id: string): Promise<boolean> {
  const allowed = await accessToConversation(prisma, viewer.oid, id);
  return allowed !== undefined && canReadDeck(allowed.access);
}

/** The latest version of a conversation's deck, outline and all, under the same rule as its pictures; `null` while it has none. */
export async function readableDeck(viewer: Identity, id: string): Promise<DeckView | null | undefined> {
  if (!(await deckReadable(viewer, id))) {
    return undefined;
  }
  return await deckView(prisma, id);
}

/** One picture of a conversation's deck, for anyone `canReadDeck` lets read it; `undefined` for everyone else. */
export async function deckAsset(viewer: Identity, id: string, sha256: string): Promise<DeckAsset | undefined> {
  if (!isSha256(sha256) || !(await deckReadable(viewer, id))) {
    return undefined;
  }
  return await readDeckAsset(prisma, id, sha256);
}

/** One version's .pptx, under the same rule as its pictures. */
export async function deckPptx(viewer: Identity, id: string, version: number): Promise<{ title: string; bytes: Uint8Array } | undefined> {
  if (!(await deckReadable(viewer, id))) {
    return undefined;
  }
  return await readDeckPptx(prisma, id, version);
}

/** Who one of the viewer's own conversations is shared with, or `undefined` when it is not theirs to share. */
export async function chatShares(viewer: Identity, id: string): Promise<SharePerson[] | undefined> {
  const conversation = await conversationRef(prisma, id);
  if (conversation === undefined || !isOwner(viewer.oid, conversation)) {
    return undefined;
  }
  return await shareRecipients(prisma, id);
}

/** Who one of the viewer's own conversations is offered to fork, or `undefined` when it is not theirs to offer. */
export async function chatForks(viewer: Identity, id: string): Promise<SharePerson[] | undefined> {
  const conversation = await conversationRef(prisma, id);
  if (conversation === undefined || !isOwner(viewer.oid, conversation)) {
    return undefined;
  }
  return await forkRecipients(prisma, id);
}

/**
 * Both sides of the viewer's shares and fork offers: their own chats they have shared or offered, and the chats
 * shared with or offered to them.
 */
export interface SharedChats {
  given: SharedChatLink[];
  received: SharedChatLink[];
  offered: SharedChatLink[];
  forkable: SharedChatLink[];
}

export async function sharedChats(viewer: Identity): Promise<SharedChats> {
  const [given, received, offered, forkable] = await Promise.all([
    conversationsSharedBy(prisma, viewer.oid),
    conversationsSharedWith(prisma, viewer.oid),
    conversationsOfferedBy(prisma, viewer.oid),
    conversationsForkableBy(prisma, viewer.oid)
  ]);
  return { given, received, offered, forkable };
}
