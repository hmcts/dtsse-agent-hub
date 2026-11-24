"use client";

import type { Field } from "@hmcts-cft/bulk-scan-spec";
import type { ReactNode } from "react";
import { casePathWords, clearLogicText, conditionsOf, type FieldPatch, logicWords, withoutKey, withRequired, wordsOf, writeAsRules } from "@/bulk-scan/edit";
import { MANDATORY_CHOICES } from "@/bulk-scan/outline";
import { BulkScanConditions, type KeyChoice } from "@/components/assistant/BulkScanConditions";
import { BulkScanSends } from "@/components/assistant/BulkScanKeys";
import { Card, CommitInput, FOCUS, Icon, INPUT, Labelled, SMALL_BUTTON } from "@/components/assistant/BulkScanParts";
import { BulkScanRules } from "@/components/assistant/BulkScanRules";

const INPUT_TYPES = ["text", "checkbox", "date", "qr", "none"] as const;

/** What a field's editor needs of the form around it. */
export interface FormChoices {
  /** Keys and sheet ids a condition may test. */
  conditions: KeyChoice[];
  /** Keys a rule may copy from. */
  keys: KeyChoice[];
  ccd: string[];
}

/**
 * The cards of one field: the question, what Exela sends, where it goes in CCD, its rules, and what is still to review.
 * `onPatch` changes the row values, `onField` changes anything else of the field.
 */
export function BulkScanFieldDetails({
  field,
  choices,
  problems,
  onPatch,
  onField,
  onClearTodo,
  onClearReview,
  ccdStatus
}: Readonly<{
  field: Field;
  choices: FormChoices;
  problems: readonly string[];
  onPatch: (patch: FieldPatch) => void;
  onField: (change: (field: Field) => Field) => void;
  onClearTodo: (index: number) => void;
  onClearReview: (index: number) => void;
  /** Where the field stands against the form's case type, drawn under the CCD ids. */
  ccdStatus?: ReactNode;
}>) {
  const review = field.review ?? [];
  return (
    <div className="flex flex-col gap-4">
      {problems.length > 0 ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-asst-error px-4 py-3 text-[13px] text-asst-error">
          <Icon name="error" className="mt-0.5 h-4 w-4" />
          <div className="flex flex-col gap-1">
            <span className="font-semibold">The engine refused this field</span>
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <Card title="Question">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
          <Labelled label="ID">
            <input value={field.id ?? ""} className={INPUT} onChange={(e) => onPatch({ id: e.target.value })} />
          </Labelled>
          <Labelled label="Label">
            <textarea
              value={field.label}
              rows={1}
              className={`${INPUT} field-sizing-content resize-none`}
              onChange={(e) => onPatch({ label: e.target.value })}
            />
          </Labelled>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Labelled label="Input type">
            <select value={field.inputType} className={INPUT} onChange={(e) => onPatch({ inputType: e.target.value as FieldPatch["inputType"] })}>
              {INPUT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Mandatory">
            <select value={field.mandatory} className={INPUT} onChange={(e) => onPatch({ mandatory: e.target.value as FieldPatch["mandatory"] })}>
              {MANDATORY_CHOICES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Labelled>
        </div>
        {field.mandatory === "conditional" ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-asst-line bg-asst-bg p-3">
            {field.required && !field.required.when ? (
              <p className="text-xs text-asst-muted">{`The sheet says "${field.required.label}", which is not tied to a key yet.`}</p>
            ) : null}
            <BulkScanConditions
              label="mandatory condition"
              lead="Mandatory if"
              conditions={conditionsOf(field.required?.when)}
              choices={choices.conditions}
              onChange={(next) => onField((f) => withRequired(f, next))}
            />
          </div>
        ) : null}
      </Card>

      <BulkScanSends
        field={field}
        onKeys={(keys) => onPatch({ keys })}
        onRemoveKey={(index) => onField((f) => withoutKey(f, index))}
        onFormat={(patch) => onPatch(patch)}
        onField={onField}
      />

      <Card title="Where it goes in CCD">
        <Labelled label="CCD ids, separated by spaces">
          <CcdIds value={field.ccd} onChange={(ccd) => onPatch({ ccd })} />
        </Labelled>
        {ccdStatus}
      </Card>

      <Card title="Rules">
        {field.logicText ? (
          <div className="flex flex-col gap-1.5 rounded-lg bg-asst-warn/20 px-3 py-2 text-xs text-asst-text">
            <span className="font-semibold">The sheet's logic, not yet written as rules</span>
            <pre className="whitespace-pre-wrap font-sans text-[13px]">{field.logicText}</pre>
            <div className="flex flex-wrap gap-1.5">
              {field.rules.length === 0 ? (
                <button type="button" className={SMALL_BUTTON} onClick={() => onField(writeAsRules)}>
                  Write as rules
                </button>
              ) : null}
              <button type="button" className={SMALL_BUTTON} onClick={() => onField(clearLogicText)}>
                Remove English
              </button>
            </div>
          </div>
        ) : null}
        {field.logicText && field.rules.length === 0 ? null : (
          <BulkScanRules
            field={field}
            conditionChoices={choices.conditions}
            keyChoices={choices.keys}
            ccdChoices={choices.ccd}
            onChange={(next) => onField(() => next)}
          />
        )}
        <SheetWords field={field} />
      </Card>

      {review.length > 0 || field.todo.length > 0 ? (
        <Card title="Review">
          <ul className="flex flex-col gap-2">
            {field.todo.map((todo, i) => (
              <li key={`${i}-${todo}`} className="flex items-start gap-2 rounded-lg bg-asst-warn/20 px-3 py-2 text-[13px] text-asst-text">
                <span className="flex-1">
                  <span className="font-semibold">TODO: </span>
                  {todo.replace(/^TODO:\s*/, "")}
                </span>
                <DoneButton label={`Done: TODO ${i + 1}`} onClick={() => onClearTodo(i)} />
              </li>
            ))}
            {review.map((r, i) => (
              <li key={`${i}-${r.about}-${r.reason}`} className="flex items-start gap-2 rounded-lg bg-asst-warn/20 px-3 py-2 text-[13px] text-asst-text">
                <span className="flex-1">
                  <span className="font-semibold">{`Check the ${r.about} `}</span>
                  <span className="text-asst-muted">{`(${r.confidence} confidence) `}</span>
                  {r.reason}
                </span>
                <DoneButton label={`Done: check ${i + 1}`} onClick={() => onClearReview(i)} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function DoneButton({ label, onClick }: Readonly<{ label: string; onClick: () => void }>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-asst-line bg-asst-bg text-asst-ok hover:bg-asst-hover ${FOCUS}`}
    >
      <Icon name="check" />
    </button>
  );
}

/** The English the transformation sheet will carry for the field's rules, and the case path they produce. */
function SheetWords({ field }: Readonly<{ field: Field }>) {
  // The English a field only has as text is shown once, in its own callout, and is not what the sheet will say of rules.
  const words = field.rules.length > 0 || field.logicPreamble ? logicWords(field) : "";
  const casePath = casePathWords(field);
  if (words === "" && casePath === "") {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-asst-muted">The transformation sheet will say:</span>
      {words === "" ? null : (
        <div role="group" aria-label="Transformation sheet logic">
          <pre className="whitespace-pre-wrap rounded-lg bg-asst-bg px-3 py-2 font-sans text-[13px] text-asst-text">{words}</pre>
        </div>
      )}
      {casePath === "" ? null : (
        <div role="group" aria-label="Transformation sheet case path">
          <pre className="whitespace-pre-wrap rounded-lg bg-asst-bg px-3 py-2 font-sans text-[13px] text-asst-muted">{casePath}</pre>
        </div>
      )}
    </div>
  );
}

/** CCD ids typed as words: the text goes up when the person leaves the box or presses Enter. */
function CcdIds({ value, onChange }: Readonly<{ value: readonly string[]; onChange: (ids: string[]) => void }>) {
  return <CommitInput label="CCD ids" value={value.join(" ")} normalise={(text) => wordsOf(text).join(" ")} onCommit={(text) => onChange(wordsOf(text))} />;
}
