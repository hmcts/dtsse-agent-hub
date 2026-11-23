"use client";

import type { Field } from "@hmcts-cft/bulk-scan-spec";
import { useRef, useState } from "react";
import { allowedFor, maxLengthOf, withAllowed, withGroup } from "@/bulk-scan/edit";
import { AddButton, Card, CommitInput, IconButton, INPUT, Labelled } from "@/components/assistant/BulkScanParts";

type ChangeField = (change: (field: Field) => Field) => void;

/** What Exela sends for a field: its keys, the values each key may carry, whether the keys are exclusive, and the format of the text. */
export function BulkScanSends({
  field,
  onKeys,
  onFormat,
  onField
}: Readonly<{
  field: Field;
  onKeys: (keys: string[]) => void;
  onFormat: (patch: { regex?: string; minLength?: number | undefined; maxLength?: number | undefined }) => void;
  onField: ChangeField;
}>) {
  const named = field.keys.filter((k) => k !== "");
  return (
    <Card title="What Exela sends" hint="The keys this question arrives under, and the strings each may carry.">
      <div className="flex flex-col gap-2">
        {field.keys.map((key, i) => (
          // A key is named by its place until it is typed, which is also what a rename follows.
          <div key={i} className="flex items-end gap-1.5">
            <Labelled label={field.keys.length > 1 ? `Key ${i + 1}` : "Key"} className="flex-1">
              <CommitInput label={`Key ${i + 1}`} value={key} onCommit={(text) => onKeys(field.keys.map((k, at) => (at === i ? text.trim() : k)))} />
            </Labelled>
            <IconButton label={`Remove key ${i + 1}`} icon="remove" onClick={() => onKeys(field.keys.filter((_, at) => at !== i))} />
          </div>
        ))}
        <div>
          <AddButton label="Add a key" text="Add a key" onClick={() => onKeys([...field.keys, ""])} />
        </div>
      </div>

      {named.length > 1 ? (
        <label className="flex items-start gap-2 text-[13px] text-asst-text">
          <input type="checkbox" className="mt-0.5" checked={field.group !== undefined} onChange={(e) => onField((f) => withGroup(f, e.target.checked))} />
          <span>
            Keys are mutually exclusive (XoR)
            <span className="block text-xs text-asst-muted">Exactly one of these keys is ticked; the others are blank.</span>
          </span>
        </label>
      ) : null}

      {named.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold text-asst-text">Allowed values</h4>
          {named.map((key, i) => (
            <AllowedValues key={`${key}-${i}`} field={field} keyName={key} onField={onField} />
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <Labelled label="Regex">
          <input value={field.regex ?? ""} placeholder="e.g. ^[XG]\d+$" className={INPUT} onChange={(e) => onFormat({ regex: e.target.value })} />
        </Labelled>
        <Labelled label="Min length">
          <LengthInput value={field.minLength} onChange={(minLength) => onFormat({ minLength })} />
        </Labelled>
        <Labelled label="Max length">
          <LengthInput value={field.maxLength} onChange={(maxLength) => onFormat({ maxLength })} />
        </Labelled>
      </div>
    </Card>
  );
}

/** A length typed as digits only, so what is sent is always a number or nothing. */
function LengthInput({ value, onChange }: Readonly<{ value: number | undefined; onChange: (value: number | undefined) => void }>) {
  return (
    <input
      value={value ?? ""}
      inputMode="numeric"
      className={INPUT}
      onChange={(e) => {
        if (/^\d*$/.test(e.target.value)) {
          onChange(maxLengthOf(e.target.value));
        }
      }}
    />
  );
}

/**
 * One key's allowed values as a list of boxes, with blank as a value of its own. The boxes are kept as typed, because a
 * box just added is empty and only the filled ones are values.
 */
function AllowedValues({ field, keyName, onField }: Readonly<{ field: Field; keyName: string; onField: ChangeField }>) {
  const { values, blankAllowed } = allowedFor(field, keyName);
  const [rows, setRows] = useState<string[]>(values);
  const focusNext = useRef(false);
  const send = (next: string[]) => {
    setRows(next);
    onField((f) =>
      withAllowed(
        f,
        keyName,
        next.filter((v) => v !== ""),
        allowedFor(f, keyName).blankAllowed
      )
    );
  };
  return (
    <div role="group" aria-label={`Allowed values of ${keyName}`} className="flex flex-col gap-1.5 rounded-lg border border-asst-line bg-asst-bg p-2.5">
      <span className="text-xs font-medium text-asst-muted">{keyName}</span>
      {rows.length === 0 ? <span className="text-xs text-asst-muted">Any text: no values are listed.</span> : null}
      {rows.map((value, i) => (
        // A value has no identity but its place in the list.
        <div key={i} className="flex items-center gap-1.5">
          <input
            aria-label={`${keyName} value ${i + 1}`}
            value={value}
            ref={(box) => {
              if (box && focusNext.current && i === rows.length - 1) {
                focusNext.current = false;
                box.focus();
              }
            }}
            className={`${INPUT} flex-1`}
            onChange={(e) => send(rows.map((v, at) => (at === i ? e.target.value : v)))}
          />
          <IconButton label={`Remove ${keyName} value ${i + 1}`} icon="remove" onClick={() => send(rows.filter((_, at) => at !== i))} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <AddButton
          label={`Add a value for ${keyName}`}
          text="Add a value"
          onClick={() => {
            focusNext.current = true;
            setRows([...rows, ""]);
          }}
        />
        <label className="flex items-center gap-1.5 text-xs text-asst-text">
          <input
            type="checkbox"
            aria-label={`Blank is allowed for ${keyName}`}
            checked={blankAllowed}
            disabled={values.length === 0}
            title={values.length === 0 ? "A free-text key can always be blank" : undefined}
            onChange={(e) => onField((f) => withAllowed(f, keyName, allowedFor(f, keyName).values, e.target.checked))}
          />
          Blank allowed
        </label>
      </div>
    </div>
  );
}
