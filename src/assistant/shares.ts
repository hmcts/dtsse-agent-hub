import {
  type ConversationAccess,
  type ConversationShare,
  canManageConversationShares,
  canShareConversationWith,
  canViewSharedConversation,
  conversationAccess,
  type SharedConversationRef
} from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/store.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { productLabel } from "./products.ts";
import { announce, ConversationNotFound } from "./store.ts";

/**
 * Who, besides its owner, may read a CFT Workspace conversation.
 *
 * A share is one row naming one person, and the rows are the whole of the access: the link an owner copies resolves
 * for the people named and for nobody else, so taking a row away is the whole of the revocation. Every decision here
 * is `src/access/rules.ts`'s; this file only loads the rows it is applied to and makes the two writes it gates.
 */

/**
 * Every offer of one conversation to be forked, in a share's shape. A fork row lets its recipient read the share page
 * as well as take a copy — nobody decides to carry on a chat they have not seen — so the read rules take these rows
 * beside the shares, and `canForkConversation` takes them alone.
 */
export async function forksOf(db: Database, conversationId: string): Promise<ConversationShare[]> {
  const rows = await db.assistantConversationFork.findMany({
    where: { conversationId },
    select: { conversationId: true, recipientOid: true },
    orderBy: { recipientOid: "asc" }
  });
  return rows.map((row) => ({ conversationId: row.conversationId, recipientOid: row.recipientOid }));
}

/** The conversation as the share rules read it, whoever is asking. `findConversation` is the owner's read. */
export interface SharedConversationRow extends SharedConversationRef {
  /** The virtual agent whose pod runs its sessions, or null for a conversation that is a local session. */
  virtualAgentId: string | null;
}

/** The conversation, if it exists, without regard to who is asking: `conversationAccess` decides that next. */
export async function conversationRef(db: Database, id: string): Promise<SharedConversationRow | undefined> {
  if (!isUuid(id)) {
    return undefined;
  }
  const row = await db.assistantConversation.findUnique({ where: { id }, select: { id: true, ownerOid: true, virtualAgentId: true } });
  return row ?? undefined;
}

/** Every share of one conversation, as the rules take them. */
export async function sharesOf(db: Database, conversationId: string): Promise<ConversationShare[]> {
  const rows = await db.assistantConversationShare.findMany({
    where: { conversationId },
    select: { conversationId: true, recipientOid: true },
    orderBy: { recipientOid: "asc" }
  });
  return rows.map((row) => ({ conversationId: row.conversationId, recipientOid: row.recipientOid }));
}

/**
 * The conversation and what the viewer may do with it, or `undefined` when they may do nothing with it — which is
 * also the answer for one that does not exist, so a share page cannot be used to tell the two apart.
 */
export async function accessToConversation(
  db: Database,
  viewerOid: string,
  id: string
): Promise<{ conversation: SharedConversationRow; access: ConversationAccess; forks: ConversationShare[] } | undefined> {
  const conversation = await conversationRef(db, id);
  if (conversation === undefined) {
    return undefined;
  }
  const [shares, forks] = await Promise.all([sharesOf(db, id), forksOf(db, id)]);
  const readers = [...shares, ...forks];
  if (!canViewSharedConversation(viewerOid, conversation, readers)) {
    return undefined;
  }
  return { conversation, access: conversationAccess(viewerOid, conversation, readers), forks };
}

export interface SharePerson {
  oid: string;
  name: string;
  email: string | null;
  sharedAt: string;
}

/** Who the conversation is shared with, oldest first. Only its owner reads this: `canManageConversationShares`. */
export async function shareRecipients(db: Database, conversationId: string): Promise<SharePerson[]> {
  const rows = await db.assistantConversationShare.findMany({
    where: { conversationId },
    select: { createdAt: true, recipient: { select: { oid: true, name: true, email: true } } },
    orderBy: [{ createdAt: "asc" }, { recipientOid: "asc" }]
  });
  return rows.map((row) => ({ ...row.recipient, sharedAt: row.createdAt.toISOString() }));
}

/**
 * Tells the owner's open tabs that the conversation changed, inside the transaction that changed it, as every other
 * write to a conversation does. The event carries no names: a tab re-reads, with the rules applied again.
 *
 * Nothing is sent to the recipient, because a share has nothing live in it: their page is a snapshot of the thread
 * and reads again when they open it. That is also what makes a revoked share stop working at the next read.
 *
 * `announce` and not a second `assistant_conversation` of its own, so a conversation with no pod — which has no such
 * event to send, and which nothing creates yet — is refused in the one place that decides it.
 */
async function announceShares(db: Database, conversation: SharedConversationRow): Promise<void> {
  await announce(db, conversation);
}

/** The owner's conversation, or the 404 anyone else's is reported as. */
async function ownedConversation(db: Database, actorOid: string, id: string): Promise<SharedConversationRow> {
  const conversation = await conversationRef(db, id);
  if (conversation === undefined || !canManageConversationShares(actorOid, conversation)) {
    throw new ConversationNotFound();
  }
  return conversation;
}

/** Shares the owner's conversation with one person, read-only. Sharing with someone already named changes nothing. */
export async function shareConversation(prisma: PrismaClient, actorOid: string, id: string, recipientOid: string): Promise<SharePerson[]> {
  const conversation = await ownedConversation(prisma, actorOid, id);
  const known = (await prisma.user.count({ where: { oid: recipientOid } })) > 0;
  if (!canShareConversationWith(actorOid, conversation, recipientOid, known)) {
    throw new HttpError(
      400,
      recipientOid === conversation.ownerOid ? "this chat is already yours" : "that person has not used the hub yet, so cannot be shared with"
    );
  }
  await prisma.$transaction(async (tx) => {
    // Skipping the duplicate rather than updating it keeps the share's own `created_at`, and leaves a second share
    // with the same person as a write that changed nothing — so, like a revocation of a share nobody held, it is
    // not announced.
    const { count } = await tx.assistantConversationShare.createMany({
      data: [{ conversationId: id, recipientOid, sharedByOid: actorOid }],
      skipDuplicates: true
    });
    if (count > 0) {
      await announceShares(tx, conversation);
    }
  });
  return await shareRecipients(prisma, id);
}

/** Takes one person off the list. Their link stops resolving at their next read. */
export async function unshareConversation(prisma: PrismaClient, actorOid: string, id: string, recipientOid: string): Promise<SharePerson[]> {
  const conversation = await ownedConversation(prisma, actorOid, id);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantConversationShare.deleteMany({ where: { conversationId: id, recipientOid } });
    if (count > 0) {
      await announceShares(tx, conversation);
    }
  });
  return await shareRecipients(prisma, id);
}

export interface SharedChatLink {
  id: string;
  title: string;
  productLabel: string;
  lastActiveAt: string;
  /** The other person: the owner for a chat shared with the viewer, and how many people for one they shared. */
  withWhom: string;
}

const SHARED_LIST_LIMIT = 200;

/** The conversations shared with the viewer, most recently active first. Nothing of anyone else's appears here. */
export async function conversationsSharedWith(db: Database, viewerOid: string): Promise<SharedChatLink[]> {
  const rows = await db.assistantConversationShare.findMany({
    where: { recipientOid: viewerOid },
    select: { conversation: { select: { id: true, title: true, product: true, lastActiveAt: true, owner: { select: { name: true } } } } },
    orderBy: [{ conversation: { lastActiveAt: "desc" } }, { conversationId: "asc" }],
    take: SHARED_LIST_LIMIT
  });
  return rows.map((row) => ({
    id: row.conversation.id,
    title: row.conversation.title ?? "New chat",
    productLabel: productLabel(row.conversation.product),
    lastActiveAt: row.conversation.lastActiveAt.toISOString(),
    withWhom: row.conversation.owner.name
  }));
}

/** The viewer's own conversations that they have shared, with how many people each is shared with. */
export async function conversationsSharedBy(db: Database, ownerOid: string): Promise<SharedChatLink[]> {
  const rows = await db.assistantConversation.findMany({
    where: { ownerOid, shares: { some: {} } },
    select: { id: true, title: true, product: true, lastActiveAt: true, _count: { select: { shares: true } } },
    orderBy: [{ lastActiveAt: "desc" }, { id: "asc" }],
    take: SHARED_LIST_LIMIT
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? "New chat",
    productLabel: productLabel(row.product),
    lastActiveAt: row.lastActiveAt.toISOString(),
    withWhom: row._count.shares === 1 ? "1 person" : `${row._count.shares} people`
  }));
}
