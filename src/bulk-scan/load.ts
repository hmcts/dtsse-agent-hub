import { HttpError } from "../agent-api/http.ts";
import type { Database } from "../store/prisma.ts";
import { checkSpec } from "./spec.ts";
import { readSpec, type SpecTarget } from "./spec-store.ts";

/** One of the owner's specs at a version, or its latest, as the engine reads it; a 404 when it is not theirs. */
export async function loadSpec(db: Database, target: SpecTarget, id: string, version?: number) {
  const record = await readSpec(db, target, id, version);
  if (!record) {
    throw new HttpError(404, "that form spec, or that version of it, does not exist");
  }
  const checked = checkSpec(record.spec);
  if (!checked.ok) {
    throw new HttpError(
      422,
      `that version cannot be used as it stands (${checked.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}): save a corrected version`
    );
  }
  return { record, spec: checked.spec };
}
