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

const COLUMNS = [
  ["ID", "w-16"],
  ["Label", "w-[22%]"],
  ["Keys", "w-[17%]"],
  ["Input type", "w-24"],
  ["Mandatory", "w-32"],
  ["Regex", "w-[15%]"],
  ["Min length", "w-24"],
  ["Max length", "w-24"],
  ["CCD ids", "w-[17%]"],
  ["Row", "w-24"]
] as const;

const ICONS = {
  up: "M5 12.5 10 7.5l5 5",
  down: "M5 7.5l5 5 5-5",
  remove: "M5.5 5.5l9 9M14.5 5.5l-9 9"
} as const;

/** A compact icon button that is named, and shows its name as a tooltip, by `label`. */
function IconButton({ label, icon, disabled, onClick }: Readonly<{ label: string; icon: keyof typeof ICONS; disabled?: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-asst-line text-asst-text hover:bg-asst-hover disabled:cursor-not-allowed disabled:opacity-40"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        <path d={ICONS[icon]} />
      </svg>
    </button>
  );
}

/**
 * The form's sections and fields as a table. A field's id, label, keys, input type, mandatory, regex, minimum and maximum length and
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
      <table className="w-full min-w-[1200px] table-fixed border-collapse text-left text-[13px]">
        <caption className="sr-only">Sections and fields of the form</caption>
        <thead>
          <tr className="border-b border-asst-line text-xs text-asst-muted">
            {COLUMNS.map(([heading, width]) => (
              <th key={heading} scope="col" className={`py-1.5 pr-2 font-medium ${width}`}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        {spec.sections.map((section, s) => (
          <tbody key={`${section.id}-${s}`}>
            <tr>
              <th scope="colgroup" colSpan={10} className="bg-asst-panel px-2 py-1.5 text-xs font-semibold">
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`ID of section ${s + 1}`}
                    value={section.id}
                    className={`${CELL} w-16`}
                    onChange={(e) => onSpec(patchSection(spec, s, { id: e.target.value }), false)}
                  />
                  <input
                    aria-label={`Title of section ${s + 1}`}
                    value={section.title}
                    className={`${CELL} max-w-xl`}
                    onChange={(e) => onSpec(patchSection(spec, s, { title: e.target.value }), false)}
                  />
                  <div className="ml-auto flex gap-1">
                    <IconButton label={`Move section ${s + 1} up`} icon="up" disabled={s === 0} onClick={() => onSpec(moveSection(spec, s, -1), true)} />
                    <IconButton
                      label={`Move section ${s + 1} down`}
                      icon="down"
                      disabled={s === spec.sections.length - 1}
                      onClick={() => onSpec(moveSection(spec, s, 1), true)}
                    />
                    <IconButton label={`Remove section ${s + 1}`} icon="remove" onClick={() => onSpec(removeSection(spec, s), true)} />
                  </div>
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
                        placeholder="id"
                        className={CELL}
                        onChange={(e) => onChange(s, f, { id: e.target.value })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        aria-label={`Label of ${name}`}
                        value={field.label}
                        placeholder="label"
                        className={CELL}
                        onChange={(e) => onChange(s, f, { label: e.target.value })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <WordsInput label={`Keys of ${name}`} placeholder="keys" words={field.keys} onChange={(keys) => onChange(s, f, { keys })} />
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
                        placeholder="regex (e.g. ^[XG]\d+$)"
                        className={CELL}
                        onChange={(e) => onChange(s, f, { regex: e.target.value })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <LengthInput
                        label={`Minimum length of ${name}`}
                        placeholder="min length"
                        value={field.minLength}
                        onChange={(minLength) => onChange(s, f, { minLength })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <LengthInput
                        label={`Maximum length of ${name}`}
                        placeholder="max length"
                        value={field.maxLength}
                        onChange={(maxLength) => onChange(s, f, { maxLength })}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <WordsInput label={`CCD ids of ${name}`} placeholder="CCD ids" words={field.ccd} onChange={(ccd) => onChange(s, f, { ccd })} />
                    </td>
                    <td className="py-1.5">
                      <div className="flex justify-end gap-1">
                        <IconButton label={`Move ${name} up`} icon="up" disabled={f === 0} onClick={() => onSpec(moveField(spec, s, f, -1), true)} />
                        <IconButton
                          label={`Move ${name} down`}
                          icon="down"
                          disabled={f === section.fields.length - 1}
                          onClick={() => onSpec(moveField(spec, s, f, 1), true)}
                        />
                        <IconButton label={`Remove ${name}`} icon="remove" onClick={() => onSpec(removeField(spec, s, f), true)} />
                      </div>
                    </td>
                  </tr>
                  <tr className="border-b border-asst-line">
                    <td />
                    <td colSpan={9} className="pb-2 pr-2">
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
              <td colSpan={10} className="py-2">
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
 * A list typed as words. The text is kept as typed and only goes up when the person leaves the box or presses Enter, so
 * a key that is half retyped is never taken for a new key, and what names it (its allowed values, group and rules) is
 * carried to the finished spelling once. A change from outside, such as a row that moved here, replaces the text.
 */
function WordsInput({
  label,
  placeholder,
  words,
  onChange
}: Readonly<{ label: string; placeholder: string; words: readonly string[]; onChange: (words: string[]) => void }>) {
  const joined = words.join(" ");
  const [state, setState] = useState({ base: joined, text: joined });
  if (state.base !== joined) {
    setState({ base: joined, text: joined });
  }
  const commit = () => {
    const typed = wordsOf(state.text);
    if (typed.join(" ") !== joined) {
      onChange(typed);
    }
  };
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      value={state.text}
      className={CELL}
      onChange={(e) => setState({ base: state.base, text: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
        }
      }}
    />
  );
}

/** A length typed as digits only, so what is sent is always a number or nothing. */
function LengthInput({
  label,
  placeholder,
  value,
  onChange
}: Readonly<{ label: string; placeholder: string; value: number | undefined; onChange: (value: number | undefined) => void }>) {
  return (
    <input
      aria-label={label}
      placeholder={placeholder}
      value={value ?? ""}
      inputMode="numeric"
      className={CELL}
      onChange={(e) => {
        if (/^\d*$/.test(e.target.value)) {
          onChange(maxLengthOf(e.target.value));
        }
      }}
    />
  );
}
