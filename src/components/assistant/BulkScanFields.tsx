"use client";

import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { Fragment } from "react";
import { type FieldPatch, maxLengthOf, wordsOf } from "@/bulk-scan/edit";
import type { FieldNotes } from "@/bulk-scan/spec";
import { FIELD } from "@/components/assistant/WelshParts";

const INPUT_TYPES = ["text", "checkbox", "date", "qr", "none"] as const;
const MANDATORY = [
  ["mandatory", "Mandatory"],
  ["optional", "Optional"],
  ["conditional", "Mandatory if…"],
  ["not-read", "Not read"]
] as const;

const CELL = `${FIELD} w-full min-w-0`;

/**
 * The form's sections and fields as a table. A field's id, label, keys, input type, mandatory, regex, maximum length and
 * CCD ids are edited in its row. Its XoR group, allowed values and rules are shown under it, as the transformation
 * sheet words them: they are read from the sheet or the PDF and are not edited here. A field's TODOs and the guesses a
 * draft marked for review are highlighted.
 */
export function BulkScanFields({
  spec,
  notes,
  issues,
  onChange
}: Readonly<{
  spec: FormSpec;
  notes: readonly FieldNotes[];
  issues: ReadonlyMap<string, string[]>;
  onChange: (section: number, field: number, patch: FieldPatch) => void;
}>) {
  let row = 0;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] border-collapse text-left text-[13px]">
        <caption className="sr-only">Sections and fields of the form</caption>
        <thead>
          <tr className="border-b border-asst-line text-xs text-asst-muted">
            {["ID", "Label", "Keys", "Input type", "Mandatory", "Regex", "Max length", "CCD ids"].map((heading) => (
              <th key={heading} scope="col" className="py-1.5 pr-2 font-medium">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        {spec.sections.map((section, s) => (
          <tbody key={`${section.id}-${s}`}>
            <tr>
              <th scope="colgroup" colSpan={8} className="bg-asst-panel px-2 py-1.5 text-xs font-semibold">
                {[section.id, section.title].filter(Boolean).join(" ") || "Fields"}
              </th>
            </tr>
            {section.fields.map((field, f) => {
              const note = notes[row++];
              const problems = issues.get(`${s}.${f}`) ?? [];
              const name = field.id || field.keys[0] || field.label || `field ${f + 1}`;
              const flagged = field.todo.length > 0 || (field.review ?? []).length > 0;
              return (
                <Fragment key={`${s}.${f}`}>
                  <tr className="align-top">
                    <td className="py-1.5 pr-2">
                      <input
                        aria-label={`ID of ${name}`}
                        value={field.id ?? ""}
                        className={`${CELL} w-16`}
                        onChange={(e) => onChange(s, f, { id: e.target.value })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input aria-label={`Label of ${name}`} value={field.label} className={CELL} onChange={(e) => onChange(s, f, { label: e.target.value })} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        aria-label={`Keys of ${name}`}
                        value={field.keys.join(" ")}
                        className={CELL}
                        onChange={(e) => onChange(s, f, { keys: wordsOf(e.target.value) })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <select
                        aria-label={`Input type of ${name}`}
                        value={field.inputType}
                        className={CELL}
                        onChange={(e) => onChange(s, f, { inputType: e.target.value as FieldPatch["inputType"] })}
                      >
                        {INPUT_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1.5 pr-2">
                      <select
                        aria-label={`Mandatory of ${name}`}
                        value={field.mandatory}
                        className={CELL}
                        onChange={(e) => onChange(s, f, { mandatory: e.target.value as FieldPatch["mandatory"] })}
                      >
                        {MANDATORY.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        aria-label={`Regex of ${name}`}
                        value={field.regex ?? ""}
                        className={CELL}
                        onChange={(e) => onChange(s, f, { regex: e.target.value })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        aria-label={`Maximum length of ${name}`}
                        value={field.maxLength ?? ""}
                        inputMode="numeric"
                        className={`${CELL} w-20`}
                        onChange={(e) => onChange(s, f, { maxLength: maxLengthOf(e.target.value) })}
                      />
                    </td>
                    <td className="py-1.5">
                      <input
                        aria-label={`CCD ids of ${name}`}
                        value={field.ccd.join(" ")}
                        className={CELL}
                        onChange={(e) => onChange(s, f, { ccd: wordsOf(e.target.value) })}
                      />
                    </td>
                  </tr>
                  <tr className="border-b border-asst-line">
                    <td />
                    <td colSpan={7} className="pb-2 pr-2">
                      {problems.length > 0 ? (
                        <ul role="alert" className="mb-1 list-disc pl-4 text-xs text-asst-error">
                          {problems.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      ) : null}
                      <FieldDetails note={note} field={field} flagged={flagged} name={name} />
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function FieldDetails({
  note,
  field,
  flagged,
  name
}: Readonly<{ note: FieldNotes | undefined; field: FormSpec["sections"][number]["fields"][number]; flagged: boolean; name: string }>) {
  const hasDetail = (note?.rules ?? "") !== "" || (note?.allowed.length ?? 0) > 0 || field.group !== undefined || field.required !== undefined || flagged;
  if (!hasDetail) {
    return null;
  }
  return (
    <details open={flagged} className="text-xs text-asst-body">
      <summary className="cursor-pointer text-asst-muted">{`Rules and notes for ${name}`}</summary>
      <div className="mt-1 flex flex-col gap-1.5">
        {field.group ? (
          <p>
            <span className="font-medium">{`XoR group (${field.group.size}): `}</span>
            {field.group.options.map((o) => o.key).join(", ")}
          </p>
        ) : null}
        {field.required ? (
          <p>
            <span className="font-medium">Mandatory if: </span>
            {field.required.label}
          </p>
        ) : null}
        {note && note.allowed.length > 0 ? (
          <div>
            <span className="font-medium">Allowed values</span>
            <ul className="list-disc pl-4">
              {note.allowed.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {note && note.rules !== "" ? <pre className="whitespace-pre-wrap rounded-lg bg-asst-panel px-2.5 py-2 font-sans">{note.rules}</pre> : null}
        {note && note.casePath !== "" ? (
          <pre className="whitespace-pre-wrap rounded-lg bg-asst-panel px-2.5 py-2 font-sans text-asst-muted">{note.casePath}</pre>
        ) : null}
        {field.todo.map((todo) => (
          <p key={todo} className="rounded-lg bg-asst-warn/20 px-2.5 py-1.5">
            <span className="font-semibold">TODO: </span>
            {todo}
          </p>
        ))}
        {(field.review ?? []).map((r) => (
          <p key={`${r.about}-${r.reason}`} className="rounded-lg bg-asst-warn/20 px-2.5 py-1.5">
            <span className="font-semibold">{`Check the ${r.about} (${r.confidence} confidence): `}</span>
            {r.reason}
          </p>
        ))}
      </div>
    </details>
  );
}
