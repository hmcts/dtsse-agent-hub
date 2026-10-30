import { type ConversationShare, canForkConversation, canManageConversationShares, canShareConversationWith } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import type { ThreadMessage } from "../messages/direct-thread.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { conversationItems, mergeEntries, type TranscriptEntryView } from "../transcripts/conversation.ts";
import { agentConversation } from "../transcripts/views.ts";
import type { ModelRoute } from "../viewer/identity.ts";
import { FORK_CONTEXT_FILE_NAME, FORK_CONTEXT_MEDIA_TYPE, FORKED_SELECT, forkContextMarkdown, forkedView, forkThread } from "./forks.ts";
import { hasPod } from "./pods.ts";
import { productLabel } from "./products.ts";
import { conversationRef, forksOf, type SharedChatLink, type SharedConversationRow, type SharePerson } from "./shares.ts";
import { productMarks, type SharedThreadItem, sharedThreadItems, stopMarks } from "./sharing.ts";
import { announce, ConversationNotFound, createConversationAgent, ensureAssistant } from "./store.ts";
import { threadItems } from "./thread.ts";
import { PART_BYTES, partCount, storedNameOf } from "./uploads.ts";
import { UNTITLED } from "./views.ts";

/**
 * Forking a CFT Workspace conversation: the owner offers it to people they name, one at a time, and each of them
 * can take their own copy and carry on with it in their own Assistant.
 *
 * The offer is a row naming one person, as a share is, so it is chosen the same way and revoked the same way: the
 * rows are the whole of it, and removing one is the whole of the revocation. What revocation cannot reach is a copy
 * already taken, which is the recipient's own conversation from the moment it is made — as a share page they have
 * already read is theirs to remember. The original is never written by anything here: a copy is a new conversation
 * on the recipient's own assistant, with its own agent, and nothing in it refers back except to say where it came
 * from.
 *
 * The words are copied when the recipient takes the copy rather than when the owner offers it, so they get the chat
 * as it stands when they decide, which is also what its share page shows them.
 */

/** Who the conversation is offered to, oldest first. Only its owner reads this. */
export async function forkRecipients(db: Database, conversationId: string): Promise<SharePerson[]> {
  const rows = await db.assistantConversationFork.findMany({
    where: { conversationId },
    select: { createdAt: true, recipient: { select: { oid: true, name: true, email: true } } },
    orderBy: [{ createdAt: "asc" }, { recipientOid: "asc" }]
  });
  return rows.map((row) => ({ ...row.recipient, sharedAt: row.createdAt.toISOString() }));
}

/** The owner's conversation, or the 404 anyone else's is reported as. */
async function ownedConversation(db: Database, actorOid: string, id: string): Promise<SharedConversationRow> {
  const conversation = await conversationRef(db, id);
  if (conversation === undefined || !canManageConversationShares(actorOid, conversation)) {
    throw new ConversationNotFound();
  }
  return conversation;
}

/** Offers the owner's conversation to one person to fork. Offering it to someone already named changes nothing. */
export async function offerFork(prisma: PrismaClient, actorOid: string, id: string, recipientOid: string): Promise<SharePerson[]> {
  const conversation = await ownedConversation(prisma, actorOid, id);
  const known = (await prisma.user.count({ where: { oid: recipientOid } })) > 0;
  if (!canShareConversationWith(actorOid, conversation, recipientOid, known)) {
    throw new HttpError(
      400,
      recipientOid === conversation.ownerOid ? "this chat is already yours" : "that person has not used the hub yet, so cannot be offered it"
    );
  }
  await prisma.$transaction(async (tx) => {
    // As a share: the duplicate keeps its own `created_at`, and a write that changed nothing is not announced.
    const { count } = await tx.assistantConversationFork.createMany({
      data: [{ conversationId: id, recipientOid, sharedByOid: actorOid }],
      skipDuplicates: true
    });
    if (count > 0) {
      await announce(tx, conversation);
    }
  });
  return await forkRecipients(prisma, id);
}

/** Withdraws the offer from one person. A copy they already took is theirs and stays. */
export async function withdrawFork(prisma: PrismaClient, actorOid: string, id: string, recipientOid: string): Promise<SharePerson[]> {
  const conversation = await ownedConversation(prisma, actorOid, id);
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.assistantConversationFork.deleteMany({ where: { conversationId: id, recipientOid } });
    if (count > 0) {
      await announce(tx, conversation);
    }
  });
  return await forkRecipients(prisma, id);
}

/** The viewer's own copy of a conversation, if they have taken one and kept it. */
async function ownCopy(db: Database, ownerOid: string, sourceId: string): Promise<string | undefined> {
  const row = await db.assistantConversation.findFirst({
    where: { ownerOid, forkedFromId: sourceId },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  return row?.id;
}

/** What the share page offers the viewer about forking: nothing unless they were offered it, and their copy once taken. */
export async function forkChoice(
  db: Database,
  viewerOid: string,
  conversation: SharedConversationRow,
  forks: readonly ConversationShare[]
): Promise<{ copyId: string | null } | null> {
  if (!canForkConversation(viewerOid, conversation, forks)) {
    return null;
  }
  return { copyId: (await ownCopy(db, viewerOid, conversation.id)) ?? null };
}

/** How many pages of the source's transcript a copy reads; past this, it starts part-way through and says so. */
export const FORK_PAGE_LIMIT = 20;

/**
 * The source's whole thread in words, as its owner would read it page by page, rather than the one page a share
 * shows: a copy is something to carry on from, and starting it part-way through would lose what the chat was about.
 * Read as the owner, for the reason `sharedConversation` reads as the owner; `canForkConversation` has already
 * settled that the viewer may have this much.
 */
async function sourceThread(
  db: Database,
  conversation: SharedConversationRow,
  row: { agentId: string | null; productHistory: unknown; stopHistory: unknown }
): Promise<{ thread: SharedThreadItem[]; earlierHidden: boolean }> {
  if (row.agentId === null) {
    return { thread: [], earlierHidden: false };
  }
  // Read as the owner, as `conversationView` and `sharedConversation` do: the fork copies the owner's own chat, and
  // who may be offered that copy is settled by the fork rows before this is called. The ref says who to read as and
  // nothing else.
  const agent = { id: row.agentId, ownerOid: conversation.ownerOid };
  const messages = new Map<string, ThreadMessage>();
  let entries: TranscriptEntryView[] = [];
  let page = await agentConversation(db, conversation.ownerOid, agent);
  for (let read = 1; ; read += 1) {
    for (const message of page.messages) {
      messages.set(message.id, message);
    }
    entries = mergeEntries(entries, page.entries);
    if (page.olderBefore === null || read >= FORK_PAGE_LIMIT) {
      break;
    }
    page = await agentConversation(db, conversation.ownerOid, agent, { before: BigInt(page.olderBefore) });
  }
  const items = conversationItems([...messages.values()], entries);
  return {
    // `local` for the same reason `sharedConversation` passes it: on a laptop chat the person's prompts are transcript
    // entries rather than hub messages, so a copy taken without it would carry the answers and not the questions.
    thread: sharedThreadItems(threadItems(items, productMarks(row.productHistory), stopMarks(row.stopHistory), !hasPod(conversation))),
    earlierHidden: page.olderBefore !== null
  };
}

/**
 * Takes the viewer's own copy of a conversation they were offered, and answers its id: a new conversation on their own
 * assistant, with the source's words, its document and where it came from. Taking it again answers the copy they
 * already have, so a second press or a second tab does not make a second one; once they delete it, taking it again
 * makes a new one from the chat as it is then.
 *
 * Their assistant is set up if they have none, because continuing in their own Assistant is what they asked for —
 * unlike a share page, which a recipient reads without one.
 */
export async function acceptFork(prisma: PrismaClient, viewer: { oid: string; modelRoute: ModelRoute }, id: string, now: Date = new Date()): Promise<string> {
  const conversation = await conversationRef(prisma, id);
  if (conversation === undefined || !canForkConversation(viewer.oid, conversation, await forksOf(prisma, id))) {
    throw new ConversationNotFound();
  }
  const existing = await ownCopy(prisma, viewer.oid, id);
  if (existing !== undefined) {
    return existing;
  }
  const source = await prisma.assistantConversation.findUnique({
    where: { id },
    select: {
      title: true,
      product: true,
      productHistory: true,
      stopHistory: true,
      agentId: true,
      artefactTitle: true,
      artefactMarkdown: true,
      artefactVersion: true,
      owner: { select: { name: true } },
      ...FORKED_SELECT
    }
  });
  if (source === null) {
    throw new ConversationNotFound();
  }
  // Read before the transaction: it is up to `FORK_PAGE_LIMIT` reads, and none of it is what the lock below protects.
  const own = await sourceThread(prisma, conversation, source);
  // A copy of a copy carries what that one was forked from as well, so it does not start part-way through either.
  const earlier = forkedView(source);
  const { thread, cut } = forkThread([...(earlier?.thread ?? []), ...own.thread]);
  const earlierHidden = cut || own.earlierHidden || (earlier?.earlierHidden ?? false);
  const assistant = await ensureAssistant(prisma, viewer);
  return await prisma.$transaction(async (tx) => {
    // The offer's row is what two tabs taking the copy at once queue on, so one makes it and the other finds it. A
    // row gone by now was withdrawn in between, which refuses the copy as it would have a moment later.
    const offer = await tx.$queryRaw<{ found: number }[]>`
      SELECT 1 AS found FROM assistant_conversation_fork WHERE conversation_id = ${id}::uuid AND recipient_oid = ${viewer.oid} FOR UPDATE
    `;
    if (offer.length === 0) {
      throw new ConversationNotFound();
    }
    const raced = await ownCopy(tx, viewer.oid, id);
    if (raced !== undefined) {
      return raced;
    }
    const document =
      source.artefactVersion === 0
        ? {}
        : {
            artefactTitle: source.artefactTitle,
            artefactMarkdown: source.artefactMarkdown,
            artefactVersion: 1,
            // Said to be the person's, so the copy's session is told on its first message that there is a document
            // and to read it before changing it: it has never seen this one.
            artefactUpdatedBy: "user",
            artefactUpdatedAt: now
          };
    const created = await tx.assistantConversation.create({
      data: { ownerOid: viewer.oid, virtualAgentId: assistant.id, product: source.product, title: source.title, lastActiveAt: now, ...document },
      select: { id: true, ownerOid: true, virtualAgentId: true }
    });
    // In one statement, because the row's CHECK holds the fork's columns to all or none. Written raw for the reason
    // `stopAnswer` writes its history raw: Prisma's JSON input type takes no array of a named interface.
    await tx.$executeRaw`
      UPDATE assistant_conversation
         SET forked_from_id = ${id}::uuid,
             forked_from_owner_name = ${source.owner.name},
             forked_from_title = ${source.title ?? UNTITLED},
             forked_at = ${now},
             forked_thread = ${JSON.stringify(thread)}::jsonb,
             forked_earlier_hidden = ${earlierHidden}
       WHERE id = ${created.id}::uuid
    `;
    await createConversationAgent(tx, created);
    await announce(tx, created);
    return created.id;
  });
}

/**
 * Whether the copy's earlier turns are still to go to its session, which they do with the first message sent in it.
 * `false` for a conversation that is not a copy.
 */
export async function forkContextPending(db: Database, conversationId: string): Promise<boolean> {
  const count = await db.assistantConversation.count({ where: { id: conversationId, forkedAt: { not: null }, forkContextSentAt: null } });
  return count > 0;
}

/**
 * Attaches the copy's earlier turns to the first message sent in it, as a file, inside that message's transaction,
 * and answers whether it did. Every later message, and every conversation that is not a copy, attaches nothing.
 *
 * A file rather than words in the message, because the message is what the person typed and what their thread shows,
 * and because the pod already fetches a message's files to its disk before it delivers it and the envelope names
 * them by path — so this reaches the session through a route every current client takes, with no new frame field
 * for an older one to drop. The claim is the `UPDATE`, so two messages sent at once attach it once between them.
 *
 * Made at the moment of sending, rather than when the copy was taken, so the bytes' retention window starts with the
 * message that carries them: a copy taken today and first spoken in next week still hands its session the turns.
 */
export async function attachForkContext(db: Database, sent: { conversationId: string; ownerOid: string; messageId: bigint }): Promise<boolean> {
  const [row] = await db.$queryRaw<
    {
      forked_from_owner_name: string;
      forked_from_title: string | null;
      forked_at: Date;
      forked_thread: unknown;
      forked_earlier_hidden: boolean;
      artefact_version: number;
    }[]
  >`
    UPDATE assistant_conversation
       SET fork_context_sent_at = now()
     WHERE id = ${sent.conversationId}::uuid AND owner_oid = ${sent.ownerOid} AND forked_at IS NOT NULL AND fork_context_sent_at IS NULL
    RETURNING forked_from_owner_name, forked_from_title, forked_at, forked_thread, forked_earlier_hidden, artefact_version
  `;
  if (row === undefined) {
    return false;
  }
  const forked = forkedView({
    forkedAt: row.forked_at,
    forkedFromOwnerName: row.forked_from_owner_name,
    forkedFromTitle: row.forked_from_title,
    forkedThread: row.forked_thread,
    forkedEarlierHidden: row.forked_earlier_hidden
  });
  if (forked === null) {
    return false;
  }
  const bytes = new TextEncoder().encode(forkContextMarkdown(forked, row.artefact_version > 0));
  const upload = await db.assistantUpload.create({
    data: {
      conversationId: sent.conversationId,
      ownerOid: sent.ownerOid,
      messageId: sent.messageId,
      fileName: FORK_CONTEXT_FILE_NAME,
      storedName: storedNameOf(FORK_CONTEXT_FILE_NAME),
      mediaType: FORK_CONTEXT_MEDIA_TYPE,
      bytes: BigInt(bytes.byteLength),
      state: "stored"
    },
    select: { id: true }
  });
  for (let index = 0; index < partCount(bytes.byteLength); index += 1) {
    await db.assistantUploadPart.create({ data: { uploadId: upload.id, index, data: bytes.slice(index * PART_BYTES, (index + 1) * PART_BYTES) } });
  }
  return true;
}

const FORK_LIST_LIMIT = 200;

/** The conversations offered to the viewer to fork, most recently active first. */
export async function conversationsForkableBy(db: Database, viewerOid: string): Promise<SharedChatLink[]> {
  const rows = await db.assistantConversationFork.findMany({
    where: { recipientOid: viewerOid },
    select: { conversation: { select: { id: true, title: true, product: true, lastActiveAt: true, owner: { select: { name: true } } } } },
    orderBy: [{ conversation: { lastActiveAt: "desc" } }, { conversationId: "asc" }],
    take: FORK_LIST_LIMIT
  });
  return rows.map((row) => ({
    id: row.conversation.id,
    title: row.conversation.title ?? UNTITLED,
    productLabel: productLabel(row.conversation.product),
    lastActiveAt: row.conversation.lastActiveAt.toISOString(),
    withWhom: row.conversation.owner.name
  }));
}

/** The viewer's own conversations they have offered to fork, with how many people each is offered to. */
export async function conversationsOfferedBy(db: Database, ownerOid: string): Promise<SharedChatLink[]> {
  const rows = await db.assistantConversation.findMany({
    where: { ownerOid, forks: { some: {} } },
    select: { id: true, title: true, product: true, lastActiveAt: true, _count: { select: { forks: true } } },
    orderBy: [{ lastActiveAt: "desc" }, { id: "asc" }],
    take: FORK_LIST_LIMIT
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? UNTITLED,
    productLabel: productLabel(row.product),
    lastActiveAt: row.lastActiveAt.toISOString(),
    withWhom: row._count.forks === 1 ? "1 person" : `${row._count.forks} people`
  }));
}
