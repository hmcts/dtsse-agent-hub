"use client";

import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { Fragment, useState } from "react";
import {
  addField,
  addSection,
  ccdIds,
  clearReview,
  clearTodo,
  type FieldPatch,
  formKeys,
  mapField,
  maxLengthOf,
  moveField,
  moveSection,
  patchField,
  patchSection,
  removeField,
  removeSection,
  sheetIds,
  wordsOf
} from "@/bulk-scan/edit";
import { BulkScanFieldDetails, type FormChoices } from "@/components/assistant/BulkScanFieldDetails";
import { FIELD, SECONDARY } from "@/components/assistant/WelshParts";

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
 * CCD ids are edited in its row, and the row and its section can be moved, removed or added to. Everything else about a
 * field, its XoR group, condition, allowed values, rules, TODOs and review markers, is edited under it. `onSpec` takes
 * the changed spec, and says whether rows moved, which makes the issues of the last save point at the wrong rows.
 */
export function BulkScanFields({
  spec,
  issues,
  onSpec
}: Readonly<{
  spec: FormSpec;
  issues: ReadonlyMap<string, string[]>;
  onSpec: (spec: FormSpec, moved: boolean) => void;
}>) {
  const onChange = (s: number, f: number, patch: FieldPatch) => onSpec(patchField(spec, s, f, patch), false);
  const keys = formKeys(spec);
  const choices: FormChoices = {
    conditions: [...keys.map((value) => ({ value, label: value })), ...sheetIds(spec).map(({ id, label }) => ({ value: id, label: `${id} ${label}`.trim() }))],
    keys: keys.map((value) => ({ value, label: value })),
    ccd: ccdIds(spec)
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1100px] border-collapse text-left text-[13px]">
        <caption className="sr-only">Sections and fields of the form</caption>
        <thead>
          <tr className="border-b border-asst-line text-xs text-asst-muted">
            {["ID", "Label", "Keys", "Input type", "Mandatory", "Regex", "Max length", "CCD ids", "Row"].map((heading) => (
              <th key={heading} scope="col" className="py-1.5 pr-2 font-medium">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        {spec.sections.map((section, s) => (
          <tbody key={`${section.id}-${s}`}>
            <tr>
              <th scope="colgroup" colSpan={9} className="bg-asst-panel px-2 py-1.5 text-xs font-semibold">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={`ID of section ${s + 1}`}
                    value={section.id}
                    className={`${CELL} w-16`}
                    onChange={(e) => onSpec(patchSection(spec, s, { id: e.target.value }), false)}
                  />
                  <input
                    aria-label={`Title of section ${s + 1}`}
                    value={section.title}
                    className={`${CELL} w-72`}
                    onChange={(e) => onSpec(patchSection(spec, s, { title: e.target.value }), false)}
                  />
                  <button type="button" className={SECONDARY} disabled={s === 0} onClick={() => onSpec(moveSection(spec, s, -1), true)}>
                    {`Move section ${s + 1} up`}
                  </button>
                  <button type="button" className={SECONDARY} disabled={s === spec.sections.length - 1} onClick={() => onSpec(moveSection(spec, s, 1), true)}>
                    {`Move section ${s + 1} down`}
                  </button>
                  <button type="button" className={SECONDARY} onClick={() => onSpec(removeSection(spec, s), true)}>
                    {`Remove section ${s + 1}`}
                  </button>
                </div>
              </th>
            </tr>
            {section.fields.map((field, f) => {
              const problems = issues.get(`${s}.${f}`) ?? [];
              const name = field.id || field.keys[0] || field.label || `field ${f + 1}`;
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
                      <WordsInput label={`Keys of ${name}`} words={field.keys} onChange={(keys) => onChange(s, f, { keys })} />
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
                        onChange={(e) => {
                          // Digits only, so what is sent is always a number or nothing.
                          if (/^\d*$/.test(e.target.value)) {
                            onChange(s, f, { maxLength: maxLengthOf(e.target.value) });
                          }
                        }}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <WordsInput label={`CCD ids of ${name}`} words={field.ccd} onChange={(ccd) => onChange(s, f, { ccd })} />
                    </td>
                    <td className="py-1.5">
                      <div className="flex gap-1">
                        <button type="button" className={SECONDARY} disabled={f === 0} onClick={() => onSpec(moveField(spec, s, f, -1), true)}>
                          {`Move ${name} up`}
                        </button>
                        <button
                          type="button"
                          className={SECONDARY}
                          disabled={f === section.fields.length - 1}
                          onClick={() => onSpec(moveField(spec, s, f, 1), true)}
                        >
                          {`Move ${name} down`}
                        </button>
                        <button type="button" className={SECONDARY} onClick={() => onSpec(removeField(spec, s, f), true)}>
                          {`Remove ${name}`}
                        </button>
                      </div>
                    </td>
                  </tr>
                  <tr className="border-b border-asst-line">
                    <td />
                    <td colSpan={8} className="pb-2 pr-2">
                      {problems.length > 0 ? (
                        <ul role="alert" className="mb-1 list-disc pl-4 text-xs text-asst-error">
                          {problems.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      ) : null}
                      <BulkScanFieldDetails
                        field={field}
                        name={name}
                        choices={choices}
                        onField={(change) => onSpec(mapField(spec, s, f, change), false)}
                        onClearTodo={(index) => onSpec(clearTodo(spec, s, f, index), false)}
                        onClearReview={(index) => onSpec(clearReview(spec, s, f, index), false)}
                      />
                    </td>
                  </tr>
                </Fragment>
              );
            })}
            <tr>
              <td colSpan={9} className="py-2">
                <button type="button" className={SECONDARY} onClick={() => onSpec(addField(spec, s), true)}>
                  {`Add a field to section ${s + 1}`}
                </button>
              </td>
            </tr>
          </tbody>
        ))}
      </table>
      <button type="button" className={SECONDARY} onClick={() => onSpec(addSection(spec), true)}>
        Add a section
      </button>
    </div>
  );
}

/**
 * A list typed as words. The text is kept as typed and only its words go up, because showing the words joined back would
 * swallow a space or comma the moment it was typed, leaving no way to start the next one.
 */
function WordsInput({ label, words, onChange }: Readonly<{ label: string; words: readonly string[]; onChange: (words: string[]) => void }>) {
  const [text, setText] = useState(words.join(" "));
  const current = wordsOf(text);
  const shown = current.join(" ") === words.join(" ") ? text : words.join(" ");
  return (
    <input
      aria-label={label}
      value={shown}
      className={CELL}
      onChange={(e) => {
        setText(e.target.value);
        onChange(wordsOf(e.target.value));
      }}
    />
  );
}
