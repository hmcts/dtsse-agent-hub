import { isOwner } from "../access/rules.ts";
import { HttpError } from "../agent-api/http.ts";
import { isUuid } from "../agents/store.ts";
import { notify } from "../realtime/notify.ts";
import type { Database, Prisma, PrismaClient } from "../store/prisma.ts";

/**
 * Each person's Bulk Scan form specs. Owner only: `isOwner` is asked on every call and the `owner_oid` in every query makes
 * a refusal unreachable rather than merely unoffered. A save is a new version, and a version that has been signed off is
 * never written again, so the spec that was approved is the spec that is downloaded.
 */

export interface SpecTarget {
  actorOid: string;
  ownerOid: string;
}

function allow({ actorOid, ownerOid }: SpecTarget): void {
  if (!isOwner(actorOid, { ownerOid })) {
    throw new HttpError(403, "you can only change your own form specs");
  }
}

const GONE = "that form spec no longer exists";

export interface SpecSummary {
  id: string;
  name: string;
  version: number;
  savedAt: string;
  signedOff: boolean;
}

/** The owner's specs, newest first, each as its latest version: what the sidebar lists, with no spec JSON read. */
export async function listSpecs(db: Database, target: SpecTarget): Promise<SpecSummary[]> {
  allow(target);
  const rows = await db.bulkScanSpec.findMany({
    where: { ownerOid: target.ownerOid },
    select: {
      id: true,
      name: true,
      createdAt: true,
      versions: { select: { version: true, createdAt: true, signedOffAt: true }, orderBy: { version: "desc" }, take: 1 }
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }]
  });
  return rows.flatMap((row) => {
    const [latest] = row.versions;
    return latest
      ? [{ id: row.id, name: row.name, version: latest.version, savedAt: latest.createdAt.toISOString(), signedOff: latest.signedOffAt !== null }]
      : [];
  });
}

/** Whether the owner has any spec `listSpecs` lists, which is whether their sidebar has a form to mark. */
export async function hasSpecs(db: Database, ownerOid: string): Promise<boolean> {
  return (await db.bulkScanSpec.findFirst({ where: { ownerOid, versions: { some: {} } }, select: { id: true } })) !== null;
}

export interface SpecMatch {
  id: string;
  name: string;
  savedAt: Date;
}

/**
 * Up to `limit` of the owner's specs whose name holds every one of `terms`, which are lower-case already, most recently
 * saved first, each at the time of its latest version.
 */
export async function searchSpecs(db: Database, ownerOid: string, terms: readonly string[], limit: number): Promise<SpecMatch[]> {
  if (terms.length === 0) {
    return [];
  }
  return await db.$queryRaw<SpecMatch[]>`
    SELECT s.id::text AS id, s.name, v.created_at AS "savedAt"
      FROM bulk_scan_spec s
      JOIN LATERAL (SELECT created_at FROM bulk_scan_spec_version WHERE spec_id = s.id ORDER BY version DESC LIMIT 1) v ON true
     WHERE s.owner_oid = ${ownerOid}
       AND NOT EXISTS (SELECT 1 FROM unnest(${terms}::text[]) AS u(term) WHERE strpos(lower(s.name), u.term) = 0)
     ORDER BY v.created_at DESC, s.id
     LIMIT ${limit}
  `;
}

export interface VersionEntry {
  version: number;
  savedBy: string;
  savedAt: string;
  signedOffBy: string | null;
  signedOffAt: string | null;
}

export interface SpecRecord {
  id: string;
  name: string;
  /** The version `spec` is. */
  version: number;
  spec: unknown;
  /** Every version, newest first. */
  versions: VersionEntry[];
}

/** One of the owner's specs at `version`, or its latest; undefined when it is not theirs or has no such version. */
export async function readSpec(db: Database, target: SpecTarget, id: string, version?: number): Promise<SpecRecord | undefined> {
  allow(target);
  if (!isUuid(id)) {
    return undefined;
  }
  const row = await db.bulkScanSpec.findFirst({
    where: { id, ownerOid: target.ownerOid },
    select: {
      id: true,
      name: true,
      versions: {
        select: { version: true, createdAt: true, signedOffAt: true, savedBy: { select: { name: true } }, signedOffBy: { select: { name: true } } },
        orderBy: { version: "desc" }
      }
    }
  });
  const shown = row?.versions.find((v) => version === undefined || v.version === version);
  if (!row || !shown) {
    return undefined;
  }
  // Only the version being shown has its JSON read: a spec of many versions would otherwise load every one of them.
  const held = await db.bulkScanSpecVersion.findUnique({ where: { specId_version: { specId: id, version: shown.version } }, select: { spec: true } });
  return {
    id: row.id,
    name: row.name,
    version: shown.version,
    spec: held?.spec,
    versions: row.versions.map((v) => ({
      version: v.version,
      savedBy: v.savedBy.name,
      savedAt: v.createdAt.toISOString(),
      signedOffBy: v.signedOffBy?.name ?? null,
      signedOffAt: v.signedOffAt?.toISOString() ?? null
    }))
  };
}

export interface NewSpec {
  name: string;
  spec: Prisma.InputJsonValue;
}

/** Adds one spec for each form an upload held, each as its version 1, and answers their ids in order. */
export async function createSpecs(prisma: PrismaClient, target: SpecTarget, specs: readonly NewSpec[]): Promise<string[]> {
  allow(target);
  return await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const { name, spec } of specs) {
      const created = await tx.bulkScanSpec.create({
        data: { ownerOid: target.ownerOid, name, versions: { create: { version: 1, spec, savedByOid: target.actorOid } } },
        select: { id: true }
      });
      ids.push(created.id);
    }
    await notify(tx, { type: "bulk_scan_spec", owner_oid: target.ownerOid });
    return ids;
  });
}

/**
 * Saves the spec as the next version, and names the spec after it. Answers the number it got. `baseVersion` is the version
 * the edit started from, and a save is refused unless it is still the latest, so a second tab or an old version never
 * silently replaces later work.
 */
export async function saveVersion(prisma: PrismaClient, target: SpecTarget, id: string, baseVersion: number, next: NewSpec): Promise<number> {
  allow(target);
  if (!isUuid(id)) {
    throw new HttpError(404, GONE);
  }
  return await prisma.$transaction(async (tx) => {
    // The spec's row is taken first, so two saves of one spec are numbered one after the other.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bulk_scan_spec WHERE id = ${id}::uuid AND owner_oid = ${target.ownerOid} FOR UPDATE`;
    if (locked.length === 0) {
      throw new HttpError(404, GONE);
    }
    const latest = await tx.bulkScanSpecVersion.aggregate({ where: { specId: id }, _max: { version: true } });
    const newest = latest._max.version ?? 0;
    if (newest !== baseVersion) {
      throw new HttpError(
        409,
        `this form is now at version ${newest}, and this edit started from version ${baseVersion}: reload the page and make the change again on version ${newest}`
      );
    }
    const version = newest + 1;
    await tx.bulkScanSpecVersion.create({ data: { specId: id, version, spec: next.spec, savedByOid: target.actorOid } });
    await tx.bulkScanSpec.update({ where: { id }, data: { name: next.name } });
    await notify(tx, { type: "bulk_scan_spec", owner_oid: target.ownerOid });
    return version;
  });
}

/** Marks one version signed off by the actor now. A version signed off once keeps its first sign-off. */
export async function signOffVersion(prisma: PrismaClient, target: SpecTarget, id: string, version: number): Promise<void> {
  allow(target);
  if (!isUuid(id)) {
    throw new HttpError(404, GONE);
  }
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.bulkScanSpecVersion.updateMany({
      where: { specId: id, version, signedOffAt: null, bulkScanSpec: { ownerOid: target.ownerOid } },
      data: { signedOffByOid: target.actorOid, signedOffAt: new Date() }
    });
    if (count === 0) {
      throw new HttpError(409, "that version is already signed off, or no longer exists");
    }
    await notify(tx, { type: "bulk_scan_spec", owner_oid: target.ownerOid });
  });
}

/** Deletes one of the owner's specs with every version of it, and reports whether there was one. */
export async function deleteSpec(prisma: PrismaClient, target: SpecTarget, id: string): Promise<boolean> {
  allow(target);
  if (!isUuid(id)) {
    return false;
  }
  return await prisma.$transaction(async (tx) => {
    const { count } = await tx.bulkScanSpec.deleteMany({ where: { id, ownerOid: target.ownerOid } });
    if (count > 0) {
      await notify(tx, { type: "bulk_scan_spec", owner_oid: target.ownerOid });
    }
    return count > 0;
  });
}
