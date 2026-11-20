import type { Layout, Model, Ordering } from "@hmcts-cft/wa-spec";
import type { Database, PrismaClient } from "../store/prisma.ts";
import { InvalidWaSpec, readWaDocuments, WaVersionConflict, waDocuments, waSpecProblems } from "./wa-builder.ts";

/**
 * Work Allocation spec versions in Postgres, append-only per service. Anyone signed in to the Assistant may read every
 * service's, so nothing here takes a viewer.
 */

export interface WaServiceSummary {
  service: string;
  displayName: string;
  latestVersion: number;
  updatedAt: Date;
}

export interface WaSpecView {
  service: string;
  version: number;
  model: Model;
  ordering: Ordering | undefined;
  layout: Layout | undefined;
  savedBy: string;
  savedAt: Date;
}

export interface WaSpecSave {
  service: string;
  model: Model;
  ordering?: Ordering;
  layout?: Layout;
  savedBy: string;
  /** The version the edit started from; a save is refused when a later one exists. */
  basedOn?: number;
}

/** Each service's latest version, by service. */
export async function listWaServices(prisma: Database): Promise<WaServiceSummary[]> {
  const rows = await prisma.waSpecVersion.findMany({
    distinct: ["service"],
    orderBy: [{ service: "asc" }, { version: "desc" }],
    select: { service: true, displayName: true, version: true, savedAt: true }
  });
  return rows.map((row) => ({ service: row.service, displayName: row.displayName, latestVersion: row.version, updatedAt: row.savedAt }));
}

/** A version of a service's spec, the latest when none is named, or null when there is none. */
export async function getWaSpec(prisma: Database, service: string, version?: number): Promise<WaSpecView | null> {
  const row = await prisma.waSpecVersion.findFirst({
    where: { service, ...(version === undefined ? {} : { version }) },
    orderBy: { version: "desc" }
  });
  if (row === null) {
    return null;
  }
  return { service: row.service, version: row.version, ...readWaDocuments(row), savedBy: row.savedBy, savedAt: row.savedAt };
}

/** Saves the next version of a service's spec after checking it, and says which version it is. */
export async function saveWaSpec(prisma: PrismaClient, input: WaSpecSave): Promise<{ version: number }> {
  const problems = waSpecProblems(input);
  if (problems.length > 0) {
    throw new InvalidWaSpec(problems.join("\n"));
  }
  const documents = waDocuments(input);
  return await prisma.$transaction(async (tx) => {
    // Saves to one service are taken one at a time, so two cannot both be the next version.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wa_spec_version:${input.service}`}, 0))`;
    const latest = await tx.waSpecVersion.aggregate({ where: { service: input.service }, _max: { version: true } });
    const current = latest._max.version ?? 0;
    if (input.basedOn !== undefined && input.basedOn !== current) {
      throw new WaVersionConflict(current, input.basedOn);
    }
    const version = current + 1;
    await tx.waSpecVersion.create({ data: { service: input.service, version, ...documents, savedBy: input.savedBy } });
    return { version };
  });
}
