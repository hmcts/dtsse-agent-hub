"use client";

import { useId } from "react";
import {
  type ArraySchema,
  type DocmosisField,
  getAt,
  inputToStored,
  isDateOnlyFormat,
  type JsonObject,
  type ObjectSchema,
  type PathSegment,
  pathKey,
  type ScalarSchema,
  storedToInput
} from "@/components/assistant/docmosis-data";

const box = "rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-[13px] text-asst-text read-only:opacity-70";
const smallButton = "h-[26px] shrink-0 rounded-lg border border-asst-strong px-2 text-xs hover:bg-asst-field disabled:opacity-40";

export interface DocmosisFormHandlers {
  /** A value changed; `undefined` removes the key. */
  set: (path: PathSegment[], value: string | boolean | undefined) => void;
  addRow: (path: PathSegment[]) => void;
  removeRow: (path: PathSegment[], index: number) => void;
}

interface Context {
  data: JsonObject;
  issues: ReadonlyMap<string, string>;
  readOnly: boolean;
  handlers: DocmosisFormHandlers;
}

/** The template's inputs as a form, generated from its schema, edited at data paths and read-only for a reader. */
export function DocmosisForm({
  schema,
  data,
  issues,
  readOnly,
  handlers
}: {
  schema: ObjectSchema;
  data: JsonObject;
  /** The problem with a value, by `pathKey` of the data path it sits at. */
  issues: ReadonlyMap<string, string>;
  readOnly: boolean;
  handlers: DocmosisFormHandlers;
}) {
  const context: Context = { data, issues, readOnly, handlers };
  const fields = Object.entries(schema.properties);
  if (fields.length === 0) {
    return <p className="text-[13px] text-asst-muted">This template has no inputs.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {fields.map(([key, child]) => (
        <Field key={key} name={key} schema={child} path={[key]} context={context} />
      ))}
    </div>
  );
}

/** The ids of the controls line and the notes `Meta` renders under `id`, for the input they describe to point at. */
function metaIds(schema: DocmosisField, id: string): string[] {
  return [...(schema.controls.length === 0 ? [] : [`${id}-controls`]), ...schema.notes.map((_note, index) => `${id}-note-${index}`)];
}

const describedBy = (ids: (string | undefined)[]): string | undefined => {
  const present = ids.filter((id): id is string => id !== undefined);
  return present.length === 0 ? undefined : present.join(" ");
};

function Meta({ schema, id }: { schema: DocmosisField; id: string }) {
  return (
    <>
      {schema.controls.length === 0 ? null : (
        <p id={`${id}-controls`} className="text-[12px] text-asst-muted">
          Controls:{" "}
          {schema.controls.map((name, index) => (
            <span key={name}>
              {index === 0 ? "" : ", "}
              <code className="font-plex-mono">{name}</code>
            </span>
          ))}
        </p>
      )}
      {schema.notes.map((note, index) => (
        <p key={note} id={`${id}-note-${index}`} className="text-[12px] text-asst-muted">
          {note}
        </p>
      ))}
    </>
  );
}

function Field({ name, schema, path, context }: { name: string; schema: DocmosisField; path: PathSegment[]; context: Context }) {
  const id = useId();
  switch (schema.kind) {
    case "object":
      return (
        <fieldset aria-describedby={describedBy(metaIds(schema, id))} className="flex flex-col gap-3 rounded-lg border border-asst-line px-3 pb-3 pt-1">
          <legend className="px-1 text-[13px] font-medium text-asst-text">{name}</legend>
          <Meta schema={schema} id={id} />
          {Object.entries(schema.properties).map(([key, child]) => (
            <Field key={key} name={key} schema={child} path={[...path, key]} context={context} />
          ))}
        </fieldset>
      );
    case "array":
      return <Repeat id={id} name={name} schema={schema} path={path} context={context} />;
    default:
      return <Scalar id={id} name={name} schema={schema} path={path} context={context} />;
  }
}

function Scalar({ id, name, schema, path, context }: { id: string; name: string; schema: ScalarSchema; path: PathSegment[]; context: Context }) {
  const value = getAt(context.data, path);
  const { readOnly, handlers } = context;
  if (schema.kind === "boolean") {
    return (
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-[13px] font-medium text-asst-text" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={readOnly}
            aria-describedby={describedBy(metaIds(schema, id))}
            onChange={(event) => handlers.set(path, event.target.checked)}
          />
          {name}
        </label>
        <Meta schema={schema} id={id} />
      </div>
    );
  }
  const format = schema.inputFormat;
  const stored = typeof value === "string" ? value : "";
  // A date the assistant wrote in some other shape has nothing to show in a date input, so it is shown as written.
  const dateOnly = schema.kind === "date" && format !== undefined && isDateOnlyFormat(format) && (stored === "" || storedToInput(stored, format) !== "");
  const problem = context.issues.get(pathKey(path));
  const errorId = problem === undefined ? undefined : `${id}-error`;
  const hintId = schema.kind === "date" ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[13px] font-medium text-asst-text">
        {name}
      </label>
      {hintId === undefined ? null : (
        <p id={hintId} className="text-[12px] text-asst-muted">
          {format ? `date, stored as ${format}` : "date"}
        </p>
      )}
      <input
        id={id}
        type={dateOnly ? "date" : "text"}
        value={dateOnly ? storedToInput(stored, format ?? "") : stored}
        placeholder={schema.kind === "date" && !dateOnly ? (format ?? "") : undefined}
        readOnly={readOnly}
        aria-invalid={problem === undefined ? undefined : true}
        aria-describedby={describedBy([errorId, hintId, ...metaIds(schema, id)])}
        className={`w-full ${box} ${problem === undefined ? "" : "border-asst-error"}`}
        onChange={(event) => {
          const typed = dateOnly ? inputToStored(event.target.value, format) : event.target.value;
          handlers.set(path, typed === "" ? undefined : typed);
        }}
      />
      {problem === undefined ? null : (
        <p id={errorId} className="text-[12px] text-asst-error">
          {problem}
        </p>
      )}
      <Meta schema={schema} id={id} />
    </div>
  );
}

function Repeat({ id, name, schema, path, context }: { id: string; name: string; schema: ArraySchema; path: PathSegment[]; context: Context }) {
  const value = getAt(context.data, path);
  const rows = Array.isArray(value) ? value : [];
  const { readOnly, handlers } = context;
  return (
    <fieldset aria-describedby={describedBy(metaIds(schema, id))} className="flex flex-col gap-3 rounded-lg border border-asst-line px-3 pb-3 pt-1">
      <legend className="px-1 text-[13px] font-medium text-asst-text">{`${name} (repeats)`}</legend>
      <Meta schema={schema} id={id} />
      {rows.map((_row, index) => (
        // A row has no identity but its place, and removing one renumbers the rest.
        <div key={index} role="group" aria-label={`${name} ${index + 1}`} className="flex flex-col gap-3 rounded-lg bg-asst-raised p-3">
          <div className="flex items-center justify-between gap-2">
            <strong className="text-[13px] text-asst-text">{`${name} ${index + 1}`}</strong>
            {readOnly ? null : (
              <button type="button" className={smallButton} aria-label={`Remove ${name} ${index + 1}`} onClick={() => handlers.removeRow(path, index)}>
                Remove
              </button>
            )}
          </div>
          {Object.entries(schema.item.properties).map(([key, child]) => (
            <Field key={key} name={key} schema={child} path={[...path, index, key]} context={context} />
          ))}
        </div>
      ))}
      {readOnly ? null : (
        <button type="button" className={`${smallButton} self-start`} onClick={() => handlers.addRow(path)}>
          {`Add ${name} row`}
        </button>
      )}
    </fieldset>
  );
}
