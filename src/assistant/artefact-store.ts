import type { Database, PrismaClient } from "../store/prisma.ts";
import { announce, type ConversationRow } from "./conversation-row.ts";

export interface Artefact {
  title: string | null;
  markdown: string;
  version: number;
  updatedBy: "user" | "agent" | null;
  updatedAt: Date | null;
}

const EMPTY_ARTEFACT: Artefact = { title: null, markdown: "", version: 0, updatedBy: null, updatedAt: null };

export function toArtefact(row: {
  artefactTitle: string | null;
  artefactMarkdown: string;
  artefactVersion: number;
  artefactUpdatedBy: string | null;
  artefactUpdatedAt: Date | null;
}): Artefact {
  const by = row.artefactUpdatedBy;
  return {
    title: row.artefactTitle,
    markdown: row.artefactMarkdown,
    version: row.artefactVersion,
    updatedBy: by === "user" || by === "agent" ? by : null,
    updatedAt: row.artefactUpdatedAt
  };
}

export const ARTEFACT_SELECT = {
  artefactTitle: true,
  artefactMarkdown: true,
  artefactVersion: true,
  artefactUpdatedBy: true,
  artefactUpdatedAt: true
} as const;

export async function readArtefact(db: Database, conversationId: string): Promise<Artefact> {
  const row = await db.assistantConversation.findUnique({ where: { id: conversationId }, select: ARTEFACT_SELECT });
  return row === null ? EMPTY_ARTEFACT : toArtefact(row);
}

export class ArtefactConflict extends Error {
  readonly current: Artefact;

  constructor(current: Artefact) {
    super("the document has changed since that version");
    this.current = current;
  }
}

/**
 * Writes the conversation's artefact if `baseVersion` is still its version, and answers the new one. Otherwise
 * nothing is written and `ArtefactConflict` carries what is there now, for the writer to merge into. A title left
 * `null` keeps the current one.
 *
 * A document is something in the chat, so the first one records its first content (`announceFirstContent`) in the same
 * statement; the announcement every write makes is what then lists it.
 */
export async function writeArtefact(
  prisma: PrismaClient,
  conversation: Pick<ConversationRow, "id" | "virtualAgentId" | "ownerOid">,
  write: { title: string | null; markdown: string; baseVersion: number; by: "user" | "agent" },
  now: Date = new Date()
): Promise<number> {
  return await prisma.$transaction(async (tx) => {
    const updated = await tx.$queryRaw<{ version: number }[]>`
      UPDATE assistant_conversation
         SET artefact_title = COALESCE(${write.title}, artefact_title, 'Untitled document'),
             artefact_markdown = ${write.markdown},
             artefact_version = artefact_version + 1,
             artefact_updated_by = ${write.by},
             artefact_updated_at = ${now},
             first_content_at = COALESCE(first_content_at, ${now}),
             updated_at = ${now}
       WHERE id = ${conversation.id}::uuid AND artefact_version = ${write.baseVersion}::int
      RETURNING artefact_version AS version
    `;
    const [row] = updated;
    if (row === undefined) {
      throw new ArtefactConflict(await readArtefact(tx, conversation.id));
    }
    await announce(tx, conversation);
    return row.version;
  });
}
