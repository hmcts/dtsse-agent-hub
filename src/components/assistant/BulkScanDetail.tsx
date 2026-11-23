"use client";

import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { useId } from "react";
import { ccdIds, clearReview, clearTodo, type FieldPatch, formKeys, mapField, patchField, patchSection, sheetIds } from "@/bulk-scan/edit";
import { fieldName, type Identity } from "@/bulk-scan/outline";
import { BulkScanFieldDetails, type FormChoices } from "@/components/assistant/BulkScanFieldDetails";
import type { Selection } from "@/components/assistant/BulkScanOutline";
import { Card, INPUT, Labelled } from "@/components/assistant/BulkScanParts";

/** The right-hand pane: the cards of the field chosen in the outline, or the id and title of the section chosen. */
export function BulkScanDetail({
  spec,
  ids,
  selection,
  issues,
  onSpec
}: Readonly<{
  spec: FormSpec;
  ids: readonly Identity[];
  selection: Selection | null;
  issues: ReadonlyMap<string, string[]>;
  onSpec: (spec: FormSpec, moved: boolean) => void;
}>) {
  const headingId = useId();
  const section = selection ? spec.sections[selection.section] : undefined;
  if (!selection || !section) {
    return (
      <section aria-labelledby={headingId} className="rounded-xl border border-dashed border-asst-line p-6 text-[13px] text-asst-muted">
        <h2 id={headingId} className="sr-only">
          Details
        </h2>
        This form has no sections yet. Add a section in the outline.
      </section>
    );
  }
  const s = selection.section;
  const field = selection.field === null ? undefined : section.fields[selection.field];
  if (selection.field === null || !field) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <h2 id={headingId} className="text-base font-semibold">{`Section ${s + 1}`}</h2>
        <Card title="Section" hint={`${section.fields.length} ${section.fields.length === 1 ? "field" : "fields"}`}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
            <Labelled label="Section ID">
              <input value={section.id} className={INPUT} onChange={(e) => onSpec(patchSection(spec, s, { id: e.target.value }), false)} />
            </Labelled>
            <Labelled label="Section title">
              <input value={section.title} className={INPUT} onChange={(e) => onSpec(patchSection(spec, s, { title: e.target.value }), false)} />
            </Labelled>
          </div>
        </Card>
      </section>
    );
  }
  const f = selection.field;
  const keys = formKeys(spec);
  const choices: FormChoices = {
    conditions: [...keys.map((value) => ({ value, label: value })), ...sheetIds(spec).map(({ id, label }) => ({ value: id, label: `${id} ${label}`.trim() }))],
    keys: keys.map((value) => ({ value, label: value })),
    ccd: ccdIds(spec)
  };
  const name = fieldName(field, f);
  const firstLine = field.label.split("\n")[0]?.trim() ?? "";
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <h2 id={headingId} className="truncate text-base font-semibold">
        {name === firstLine ? name : `${name} ${firstLine}`.trim()}
      </h2>
      <BulkScanFieldDetails
        key={ids[s]?.fields[f] ?? `${s}.${f}`}
        field={field}
        choices={choices}
        problems={issues.get(`${s}.${f}`) ?? []}
        onPatch={(patch: FieldPatch) => onSpec(patchField(spec, s, f, patch), false)}
        onField={(change) => onSpec(mapField(spec, s, f, change), false)}
        onClearTodo={(index) => onSpec(clearTodo(spec, s, f, index), false)}
        onClearReview={(index) => onSpec(clearReview(spec, s, f, index), false)}
      />
    </section>
  );
}
