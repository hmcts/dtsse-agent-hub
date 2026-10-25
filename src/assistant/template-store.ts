import { canManageTemplate } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/store.ts";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { checkTemplate, MAX_TEMPLATES, type SavedTemplate, TEMPLATES_FULL, templateNameTaken } from "./templates.ts";

/**
 * Each person's own saved prompts. `canManageTemplate` is asked on every call, so the one rule covers reading and
 * writing and nothing here decides for itself; the `owner_oid` in every query is what makes a refusal unreachable
 * rather than merely unoffered.
 *
 * No caller passes an owner a browser named: the actions hand both ids from the viewer they re-read, so `actorOid`
 * and `ownerOid` being the same pair is the normal case and the parameter exists to keep the rule honest.
 */

/** Postgres's unique-violation, which is this table's one-name-per-person constraint. */
const UNIQUE_VIOLATION = "P2002";

export interface TemplateTarget {
  actorOid: string;
  ownerOid: string;
}

function allow({ actorOid, ownerOid }: TemplateTarget): void {
  if (!canManageTemplate(actorOid, ownerOid)) {
    throw new HttpError(403, "you can only change your own templates");
  }
}

/** Holds the owner's `user` row until commit, so two saves by one person cannot both pass the count cap. */
async function lockOwner(db: Database, ownerOid: string): Promise<void> {
  await db.$queryRaw`SELECT 1 FROM "user" WHERE oid = ${ownerOid} FOR UPDATE`;
}

const SELECT = { id: true, name: true, body: true } as const;

function view(row: { id: string; name: string; body: string }): SavedTemplate {
  return { id: row.id, name: row.name, text: row.body };
}

/** The owner's templates, by name. Capped at `MAX_TEMPLATES`, which is also what a save is allowed to grow them to. */
export async function listTemplates(db: Database, target: TemplateTarget): Promise<SavedTemplate[]> {
  allow(target);
  const rows = await db.assistantTemplate.findMany({
    where: { ownerOid: target.ownerOid },
    select: SELECT,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: MAX_TEMPLATES
  });
  return rows.map(view);
}

export interface TemplateWrite extends TemplateTarget {
  /** The template being replaced, or `undefined` to add one. */
  id?: string;
  name: unknown;
  body: unknown;
}

/**
 * Adds a template or replaces one of the owner's own, and answers it as saved.
 *
 * An id that is not one of this person's templates is not an update of somebody else's — the `where` carries the
 * owner, so it matches nothing and the person is told the template has gone.
 */
export async function saveTemplate(prisma: PrismaClient, write: TemplateWrite): Promise<SavedTemplate> {
  allow(write);
  const checked = checkTemplate(write);
  if (!checked.ok) {
    throw new HttpError(400, checked.error);
  }
  const { name, text } = checked.template;
  const data = { name, body: text };
  try {
    return await prisma.$transaction(async (tx) => {
      if (write.id === undefined) {
        // The owner's row is taken first, so the cap is read and acted on one save at a time. Counting inside the
        // transaction is not enough on its own: at this server's READ COMMITTED default two tabs each read the same
        // total, each find room for the last one, and both insert. A row over the cap is worse than an off-by-one,
        // because `listTemplates` stops at `MAX_TEMPLATES` — the extra row is then invisible in the dialog, which
        // says the person is full and gives them nothing to delete.
        await lockOwner(tx, write.ownerOid);
        if ((await tx.assistantTemplate.count({ where: { ownerOid: write.ownerOid } })) >= MAX_TEMPLATES) {
          throw new HttpError(400, TEMPLATES_FULL);
        }
        return view(await tx.assistantTemplate.create({ data: { ownerOid: write.ownerOid, ...data }, select: SELECT }));
      }
      if (!isUuid(write.id)) {
        throw new HttpError(404, "that template no longer exists");
      }
      const { count } = await tx.assistantTemplate.updateMany({
        where: { id: write.id, ownerOid: write.ownerOid },
        data: { ...data, updatedAt: new Date() }
      });
      if (count === 0) {
        throw new HttpError(404, "that template no longer exists");
      }
      return { id: write.id, name, text };
    });
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new HttpError(409, templateNameTaken(name));
    }
    throw error;
  }
}

/** Deletes one of the owner's own templates, and reports whether there was one to delete. */
export async function deleteTemplate(db: Database, target: TemplateTarget, id: string): Promise<boolean> {
  allow(target);
  if (!isUuid(id)) {
    return false;
  }
  const { count } = await db.assistantTemplate.deleteMany({ where: { id, ownerOid: target.ownerOid } });
  return count > 0;
}
