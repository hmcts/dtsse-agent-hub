import type { ConversationAccess } from "../access/rules.ts";
import type { Database } from "../store/prisma.ts";
import { conversationItems } from "../transcripts/conversation.ts";
import { agentConversation } from "../transcripts/views.ts";
import { productLabel } from "./products.ts";
import type { SharedConversationRow } from "./shares.ts";
import { readArtefact } from "./store.ts";
import { type ProductMark, type ThreadItem, threadItems } from "./thread.ts";
import { UNTITLED } from "./views.ts";

/**
 * A conversation as a read-only share of it shows it.
 *
 * What a share exposes is the words: what the person asked, what the assistant answered, where the subject changed,
 * and the conversation's document. What it does not expose is the files — not their bytes, which no route outside the
 * conversation's own pod session can reach, and not their names or sizes either, because a person chooses a file for
 * the assistant to read rather than for a colleague to be shown a list of. A message that carried files says so and
 * says how many.
 *
 * The files stay out for a second reason, which matters to anyone adding a download here. An attachment's media type
 * is what the uploading browser claimed it was, so a person can store a `text/html` file of their own making against
 * their own conversation; while only they can fetch it that is theirs to run, and nobody else's session is at risk.
 * Serving one to a recipient from this origin would make it stored cross-user scripting. A download for a share would
 * therefore have to force the served type to `application/octet-stream` for everything outside a small allowlist,
 * rather than echo the claim back.
 *
 * One residue is worth knowing: a person who attached a file and typed nothing sends a message the hub words for
 * them, "I have attached <name>. Please take a look.", and that is their message, so a share shows it as written.
 * Rewriting a stored body at read time would make the share disagree with the chat it claims to be.
 *
 * Nothing here is live. A share is a snapshot: a recipient sees whatever is there when they open the page, because
 * the hub tells only an owner's own tabs that their conversation changed, and the conversation's agent — which is
 * what a UI stream would have to be allowed to watch — is owner-only.
 */

export type SharedThreadItem =
  /** `attachmentCount` stands in for the files, whose names and sizes a share does not carry. */
  | { type: "user"; key: string; at: string; text: string; attachmentCount: number }
  | { type: "assistant"; key: string; at: string; text: string }
  | { type: "product"; key: string; at: string; label: string };

/**
 * The thread with everything a share does not carry taken out: the attachments down to a count, and the delivery
 * state, which says whether the owner's message reached their own assistant and is theirs to act on.
 */
export function sharedThreadItems(items: readonly ThreadItem[]): SharedThreadItem[] {
  return items.map((item) => {
    if (item.type === "user") {
      return { type: "user", key: item.key, at: item.at, text: item.text, attachmentCount: item.attachments.length };
    }
    return item.type === "assistant" ? { type: "assistant", key: item.key, at: item.at, text: item.text } : item;
  });
}

export interface SharedConversationView {
  id: string;
  title: string;
  productLabel: string;
  /** Whose chat it is, so a recipient knows whose words they are reading. */
  ownerName: string;
  thread: SharedThreadItem[];
  /**
   * Whether the chat began before the part shown here. A share reads one page of the transcript, the latest
   * `CONVERSATION_PAGE_SIZE` entries, and has nothing to ask for the page before it with, so a long chat opens
   * part-way through. The page says so rather than letting a recipient read a thread that starts mid-answer and
   * take it for the whole of it.
   */
  earlierHidden: boolean;
  /** The conversation's document, or `null` when it has none. Read-only here: there is no version to write against. */
  document: { title: string; markdown: string } | null;
  /** `owner` when the owner is looking at their own share, which is how they see what a recipient sees. */
  access: ConversationAccess;
}

function marks(value: unknown): ProductMark[] {
  return Array.isArray(value)
    ? value.filter((mark): mark is ProductMark => typeof mark === "object" && mark !== null && typeof mark.product === "string" && typeof mark.at === "string")
    : [];
}

/**
 * The share page's read, for a viewer `canViewSharedConversation` has already allowed.
 *
 * The thread is read as the conversation's owner, because every message in it is between them and their assistant
 * and `canReadMessage` would otherwise keep all of it from the very person the owner shared it with. That the
 * recipient is allowed this much, and no more, is settled above this call rather than here; `sharedThreadItems` is
 * what holds "no more" to the words.
 */
export async function sharedConversation(
  db: Database,
  conversation: SharedConversationRow,
  access: ConversationAccess
): Promise<SharedConversationView | undefined> {
  const row = await db.assistantConversation.findUnique({
    where: { id: conversation.id },
    select: { title: true, product: true, productHistory: true, agentId: true, owner: { select: { name: true } } }
  });
  if (row === null) {
    return undefined;
  }
  const agentId = row.agentId;
  const [page, artefact] = await Promise.all([
    agentId === null ? undefined : agentConversation(db, conversation.ownerOid, { id: agentId, ownerOid: conversation.ownerOid, ownerOnly: true }, []),
    readArtefact(db, conversation.id)
  ]);
  const items = page === undefined ? [] : conversationItems(page.messages, page.entries);
  return {
    id: conversation.id,
    title: row.title ?? UNTITLED,
    productLabel: productLabel(row.product),
    ownerName: row.owner.name,
    thread: sharedThreadItems(threadItems(items, marks(row.productHistory))),
    // `olderBefore` is the entry the owner's own page would ask for the previous page before; here it only says that
    // there is one.
    earlierHidden: page?.olderBefore !== null && page?.olderBefore !== undefined,
    document: artefact.version === 0 ? null : { title: artefact.title ?? "Untitled document", markdown: artefact.markdown },
    access
  };
}
