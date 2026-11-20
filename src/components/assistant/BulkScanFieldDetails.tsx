"use client";

import type { Field } from "@hmcts-cft/bulk-scan-spec";
import { useState } from "react";
import { allowedFor, casePathWords, clearLogicText, conditionsOf, logicWords, withAllowed, withGroup, withRequired, writeAsRules } from "@/bulk-scan/edit";
import { BulkScanConditions, type KeyChoice } from "@/components/assistant/BulkScanConditions";
import { BulkScanRules } from "@/components/assistant/BulkScanRules";
import { FIELD, SECONDARY } from "@/components/assistant/WelshParts";

/** What a field's editor needs of the form around it. */
export interface FormChoices {
  /** Keys and sheet ids a condition may test. */
  conditions: KeyChoice[];
  /** Keys a rule may copy from. */
  keys: KeyChoice[];
  ccd: string[];
}

/**
 * Everything about a field that is not a cell of its row: its XoR group, its condition for being mandatory, the exact
 * strings each key may carry, its rules with their English as the transformation sheet will word it, and the TODOs and
 * review markers a person clears once handled.
 */
export function BulkScanFieldDetails({
  field,
  name,
  choices,
  onField,
  onClearTodo,
  onClearReview
}: Readonly<{
  field: Field;
  name: string;
  choices: FormChoices;
  onField: (change: (field: Field) => Field) => void;
  onClearTodo: (index: number) => void;
  onClearReview: (index: number) => void;
}>) {
  const flagged = field.todo.length > 0 || (field.review ?? []).length > 0;
  // The English a field only has as text is shown once, in its own block, and is not what the sheet will say of rules.
  const words = field.rules.length > 0 || field.logicPreamble ? logicWords(field) : "";
  const casePath = casePathWords(field);
  const keys = field.keys.filter((k) => k !== "");
  // Opens flagged fields once; clearing their last marker must not close what the person is editing.
  const [open, setOpen] = useState(flagged);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="text-xs text-asst-body">
      <summary className="cursor-pointer text-asst-muted">{`Rules and notes for ${name}`}</summary>
      <div className="mt-2 flex flex-col gap-3">
        {field.keys.length > 1 ? (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={field.group !== undefined} onChange={(e) => onField((f) => withGroup(f, e.target.checked))} />
            {`The keys of ${name} are a mutually exclusive group (XoR)`}
          </label>
        ) : null}

        {field.mandatory === "conditional" ? (
          <div className="flex flex-col gap-1.5">
            <span className="font-medium">{`${name} is mandatory if`}</span>
            {field.required && !field.required.when ? (
              <p className="text-asst-muted">{`The sheet says "${field.required.label}", which is not tied to a key yet.`}</p>
            ) : null}
            <BulkScanConditions
              label={`mandatory condition of ${name}`}
              conditions={conditionsOf(field.required?.when)}
              choices={choices.conditions}
              onChange={(next) => onField((f) => withRequired(f, next))}
            />
          </div>
        ) : null}

        {keys.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="font-medium">Allowed values</span>
            {keys.map((key) => (
              <AllowedValues key={key} field={field} name={name} keyName={key} onField={onField} />
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <span className="font-medium">Rules</span>
          {field.logicText ? (
            <div className="flex flex-col gap-1.5 rounded-lg bg-asst-warn/20 px-2.5 py-1.5">
              <span className="font-semibold">The sheet's logic, not yet written as rules</span>
              <pre className="whitespace-pre-wrap font-sans">{field.logicText}</pre>
              <div className="flex flex-wrap gap-1.5">
                {field.rules.length === 0 ? (
                  <button type="button" className={SECONDARY} onClick={() => onField(writeAsRules)}>
                    {`Write ${name} as rules`}
                  </button>
                ) : null}
                <button type="button" className={SECONDARY} onClick={() => onField(clearLogicText)}>
                  {`Remove the English of ${name}`}
                </button>
              </div>
            </div>
          ) : null}
          {field.logicText && field.rules.length === 0 ? null : (
            <BulkScanRules
              field={field}
              name={name}
              conditionChoices={choices.conditions}
              keyChoices={choices.keys}
              ccdChoices={choices.ccd}
              onChange={(next) => onField(() => next)}
            />
          )}
          {words === "" && casePath === "" ? null : (
            <div className="flex flex-col gap-1">
              <span className="text-asst-muted">The transformation sheet will say</span>
              {words === "" ? null : (
                <div role="group" aria-label={`Logic of ${name}`}>
                  <pre className="whitespace-pre-wrap rounded-lg bg-asst-panel px-2.5 py-2 font-sans">{words}</pre>
                </div>
              )}
              {casePath === "" ? null : (
                <div role="group" aria-label={`Case path of ${name}`}>
                  <pre className="whitespace-pre-wrap rounded-lg bg-asst-panel px-2.5 py-2 font-sans text-asst-muted">{casePath}</pre>
                </div>
              )}
            </div>
          )}
        </div>

        {field.todo.map((todo, i) => (
          <p key={todo} className="flex flex-wrap items-center gap-2 rounded-lg bg-asst-warn/20 px-2.5 py-1.5">
            <span>
              <span className="font-semibold">TODO: </span>
              {todo.replace(/^TODO:\s*/, "")}
            </span>
            <button type="button" className={SECONDARY} onClick={() => onClearTodo(i)}>
              {`Done: TODO ${i + 1} of ${name}`}
            </button>
          </p>
        ))}
        {(field.review ?? []).map((r, i) => (
          <p key={`${r.about}-${r.reason}`} className="flex flex-wrap items-center gap-2 rounded-lg bg-asst-warn/20 px-2.5 py-1.5">
            <span>
              <span className="font-semibold">{`Check the ${r.about} (${r.confidence} confidence): `}</span>
              {r.reason}
            </span>
            <button type="button" className={SECONDARY} onClick={() => onClearReview(i)}>
              {`Done: check ${i + 1} of ${name}`}
            </button>
          </p>
        ))}
      </div>
    </details>
  );
}

/**
 * One key's allowed values, one per line. The text is kept as typed and only its lines go up, because showing the lines
 * joined back would swallow the new line the moment it was typed.
 */
function AllowedValues({
  field,
  name,
  keyName,
  onField
}: Readonly<{ field: Field; name: string; keyName: string; onField: (change: (field: Field) => Field) => void }>) {
  const { values, blankAllowed } = allowedFor(field, keyName);
  const [text, setText] = useState(values.join("\n"));
  const lines = (t: string) => t.split("\n").filter((l) => l !== "");
  const shown = lines(text).join("\n") === values.join("\n") ? text : values.join("\n");
  return (
    <div className="flex flex-wrap items-start gap-3">
      <label className="flex flex-col gap-1">
        {`Allowed values of ${keyName}, one per line; none means free text`}
        <textarea
          aria-label={`Allowed values of ${keyName} in ${name}`}
          value={shown}
          rows={Math.max(2, values.length + 1)}
          className={`${FIELD} w-64`}
          onChange={(e) => {
            setText(e.target.value);
            onField((f) => withAllowed(f, keyName, lines(e.target.value), allowedFor(f, keyName).blankAllowed));
          }}
        />
      </label>
      <label className="flex items-center gap-1.5 pt-5">
        <input
          type="checkbox"
          checked={blankAllowed}
          onChange={(e) => onField((f) => withAllowed(f, keyName, allowedFor(f, keyName).values, e.target.checked))}
        />
        {`Blank is allowed for ${keyName} in ${name}`}
      </label>
    </div>
  );
}
