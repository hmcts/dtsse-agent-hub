"use client";

import type { Field } from "@hmcts-cft/bulk-scan-spec";
import { NEW_FIELD_TYPES } from "@/bulk-scan/case-type";
import { CommitInput } from "@/components/assistant/BulkScanParts";
import { FIELD } from "@/components/assistant/WelshParts";

const BADGE = {
  existing: ["Existing", "border-asst-line text-asst-body"],
  new: ["New", "border-asst-accent text-asst-accent"],
  unsure: ["Unsure", "border-asst-error text-asst-error"]
} as const;

const NEW_OPTION = "\u0000new";

/**
 * Where a row's CCD field stands against the form's case type: a badge, and for an unsure row the choice between its
 * candidates and a new field, and for a new row its proposed id and CCD FieldType to edit. Draws nothing for a row with
 * no case type match.
 */
export function BulkScanCcdStatus({
  field,
  name,
  onChooseCandidate,
  onChooseNew,
  onEditNew
}: Readonly<{
  field: Field;
  /** What the row is called, for the names of its controls. */
  name: string;
  onChooseCandidate: (id: string) => void;
  onChooseNew: () => void;
  onEditNew: (patch: { id?: string; type?: string }) => void;
}>) {
  const match = field.ccdMatch;
  if (!match) {
    return null;
  }
  const [word, tone] = BADGE[match.status];
  const added = match.newField;
  return (
    <div className="mt-1 flex flex-col gap-1">
      <span title={match.reason} className={`w-fit rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
        {word}
      </span>
      {match.status === "unsure" ? (
        <select
          aria-label={`Case field for ${name}`}
          className={`${FIELD} w-full min-w-0`}
          value=""
          onChange={(event) => (event.target.value === NEW_OPTION ? onChooseNew() : onChooseCandidate(event.target.value))}
        >
          <option value="">Choose…</option>
          {(match.candidates ?? []).map((c) => (
            <option key={c.id} value={c.id}>{`${c.id} (${c.type})`}</option>
          ))}
          {added ? <option value={NEW_OPTION}>{`Add ${added.id} as a new field`}</option> : null}
        </select>
      ) : null}
      {match.status === "new" && added ? (
        <>
          <CommitInput label={`New case field id for ${name}`} value={added.id} keepValue onCommit={(id) => onEditNew({ id })} />
          <select
            aria-label={`New case field type for ${name}`}
            className={`${FIELD} w-full min-w-0`}
            value={added.type}
            onChange={(event) => onEditNew({ type: event.target.value })}
          >
            {[...new Set([...NEW_FIELD_TYPES, added.type])].map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </div>
  );
}
