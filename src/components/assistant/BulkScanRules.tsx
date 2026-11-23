"use client";

import type { Field, Outcome, Rule } from "@hmcts-cft/bulk-scan-spec";
import { capitalised } from "@hmcts-cft/bulk-scan-spec/capitalised";
import {
  type AssignmentRow,
  addRule,
  assignmentsOf,
  groupsOf,
  looksTyped,
  mapRule,
  moveRule,
  removeRule,
  withAssignments,
  withElse,
  withGroups,
  withoutAction
} from "@/bulk-scan/edit";
import { BulkScanConditions, type KeyChoice, nextCondition } from "@/components/assistant/BulkScanConditions";
import { AddButton, FOCUS, IconButton, INPUT, SMALL_BUTTON } from "@/components/assistant/BulkScanParts";

const OUTCOMES: readonly Outcome[] = ["success", "warning", "exception"];
const LEAD = "w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-asst-muted";

/**
 * A field's rules: an ordered list of branches, each a card that reads as a sentence. When its conditions all hold (or
 * any of its OR alternatives), set the CCD fields, with an outcome and a note; it may be the ELSE of the branch before
 * it or start a chain of its own.
 */
export function BulkScanRules({
  field,
  conditionChoices,
  keyChoices,
  ccdChoices,
  onChange
}: Readonly<{
  field: Field;
  conditionChoices: readonly KeyChoice[];
  keyChoices: readonly KeyChoice[];
  ccdChoices: readonly string[];
  onChange: (field: Field) => void;
}>) {
  return (
    <div className="flex flex-col gap-3">
      {field.rules.map((rule, i) => (
        // A branch has no identity but its place in the list, which is what its controls change.
        <RuleBranch
          key={i}
          label={`branch ${i + 1}`}
          rule={rule}
          first={i === 0}
          last={i === field.rules.length - 1}
          conditionChoices={conditionChoices}
          keyChoices={keyChoices}
          ccdChoices={ccdChoices}
          onChange={(change) => onChange(mapRule(field, i, change))}
          onMove={(by) => onChange(moveRule(field, i, by))}
          onRemove={() => onChange(removeRule(field, i))}
        />
      ))}
      <div>
        <AddButton label="Add a branch" text="Add a branch" onClick={() => onChange(addRule(field))} />
      </div>
    </div>
  );
}

function Toggle({ label, text, checked, onChange }: Readonly<{ label: string; text: string; checked: boolean; onChange: (checked: boolean) => void }>) {
  return (
    <label className="flex items-center gap-1.5 rounded-lg border border-asst-line px-2 py-1 text-xs font-medium text-asst-text">
      <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {text}
    </label>
  );
}

function RuleBranch({
  label,
  rule,
  first,
  last,
  conditionChoices,
  keyChoices,
  ccdChoices,
  onChange,
  onMove,
  onRemove
}: Readonly<{
  label: string;
  rule: Rule;
  first: boolean;
  last: boolean;
  conditionChoices: readonly KeyChoice[];
  keyChoices: readonly KeyChoice[];
  ccdChoices: readonly string[];
  onChange: (change: (rule: Rule) => Rule) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}>) {
  const groups = groupsOf(rule);
  const assignments = assignmentsOf(rule);
  const setRows = (rows: AssignmentRow[]) => onChange((r) => withAssignments(r, rows));
  const freeTarget = ccdChoices.find((c) => !assignments.some((a) => a.target === c));
  const firstCondition = nextCondition([], conditionChoices);
  const title = capitalised(label);
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-3 rounded-lg border border-asst-line bg-asst-bg p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-asst-text">{title}</span>
        <Toggle label={`ELSE: ${label}`} text="ELSE" checked={rule.otherwise === true} onChange={(checked) => onChange((r) => withElse(r, checked))} />
        {first ? null : (
          <Toggle
            label={`Starts a new chain: ${label}`}
            text="New chain"
            checked={rule.independent === true}
            onChange={(checked) => onChange((r) => ({ ...r, independent: checked }))}
          />
        )}
        <div className="ml-auto flex gap-1">
          <IconButton label={`Move ${label} up`} icon="up" disabled={first} onClick={() => onMove(-1)} />
          <IconButton label={`Move ${label} down`} icon="down" disabled={last} onClick={() => onMove(1)} />
          <IconButton label={`Remove ${label}`} icon="remove" onClick={onRemove} />
        </div>
      </div>

      {rule.otherwise ? (
        <p className="text-[13px] text-asst-body">
          <span className={`${LEAD} inline-block`}>Otherwise</span> when no branch before it matched
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((group, g) => (
            // An alternative has no identity but its place in the list.
            <div key={g} className="flex flex-col gap-1.5">
              <BulkScanConditions
                label={groups.length > 1 ? `${label}, alternative ${g + 1}` : label}
                lead={g === 0 ? "When" : "Or when"}
                conditions={group}
                choices={conditionChoices}
                onChange={(next) =>
                  onChange((r) =>
                    withGroups(
                      r,
                      groups.map((existing, at) => (at === g ? next : existing))
                    )
                  )
                }
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-1.5 pl-[6.375rem]">
            {groups.length === 0 ? (
              <AddButton
                label={`Add a condition to ${label}`}
                text="Add a condition"
                disabled={!firstCondition}
                onClick={() => firstCondition && onChange((r) => withGroups(r, [[firstCondition]]))}
              />
            ) : (
              <AddButton
                label={`Add an OR alternative to ${label}`}
                text="Add an OR alternative"
                disabled={!firstCondition}
                onClick={() => firstCondition && onChange((r) => withGroups(r, [...groups, [firstCondition]]))}
              />
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {assignments.map((row, i) => {
          const replace = (patch: Partial<AssignmentRow>) => setRows(assignments.map((a, at) => (at === i ? { ...a, ...patch } : a)));
          const targets = [...new Set([...ccdChoices.filter((c) => c === row.target || !assignments.some((a) => a.target === c)), row.target])];
          return (
            <div key={row.target} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={LEAD}>{i === 0 ? "Then set" : "and set"}</span>
                <select
                  aria-label={`${label}, assignment ${i + 1} CCD field`}
                  value={row.target}
                  className={`${INPUT} w-auto max-w-[14rem]`}
                  onChange={(e) => replace({ target: e.target.value })}
                >
                  {targets.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <span className="text-[13px] text-asst-body">to</span>
                <select
                  aria-label={`${label}, assignment ${i + 1} kind`}
                  value={row.copy ? "copy" : "value"}
                  className={`${INPUT} w-auto`}
                  onChange={(e) => replace(e.target.value === "copy" ? { copy: true, value: keyChoices[0]?.value ?? "" } : { copy: false, value: "" })}
                >
                  <option value="value">the value</option>
                  <option value="copy">a copy of the key</option>
                </select>
                {row.copy ? (
                  <select
                    aria-label={`${label}, assignment ${i + 1} key`}
                    value={row.value}
                    className={`${INPUT} w-auto max-w-[14rem]`}
                    onChange={(e) => replace({ value: e.target.value })}
                  >
                    {[...keyChoices, ...(keyChoices.some((k) => k.value === row.value) ? [] : [{ value: row.value, label: row.value }])].map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={`${label}, assignment ${i + 1} value`}
                    value={row.value}
                    className={`${INPUT} w-40`}
                    onChange={(e) => replace({ value: e.target.value, typed: false })}
                  />
                )}
                <IconButton label={`Remove ${label}, assignment ${i + 1}`} icon="remove" onClick={() => setRows(assignments.filter((_, at) => at !== i))} />
              </div>
              {!row.copy && looksTyped(row.value) ? (
                <label className="ml-24 flex items-center gap-1.5 pl-1.5 text-xs text-asst-body">
                  <input
                    type="checkbox"
                    aria-label={`${label}, assignment ${i + 1}: ${row.value} is the value, not the word`}
                    checked={row.typed === true}
                    onChange={(e) => replace({ typed: e.target.checked })}
                  />
                  {`${row.value} is the value, not the word`}
                </label>
              ) : null}
            </div>
          );
        })}
        <div className="pl-[6.375rem]">
          <AddButton
            label={`Add an assignment to ${label}`}
            text="Add an assignment"
            disabled={freeTarget === undefined}
            title={ccdChoices.length === 0 ? "Give a field a CCD id first" : undefined}
            onClick={() => freeTarget && setRows([...assignments, { target: freeTarget, copy: false, value: "" }])}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={LEAD}>Outcome</span>
        <select
          aria-label={`Outcome of ${label}`}
          value={rule.outcome ?? ""}
          className={`${INPUT} w-auto`}
          onChange={(e) => onChange((r) => ({ ...r, outcome: (e.target.value || undefined) as Outcome | undefined }))}
        >
          <option value="">none</option>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input
          aria-label={`Note of ${label}`}
          placeholder="Note shown with the outcome"
          value={rule.note ?? ""}
          className={`${INPUT} min-w-[14rem] flex-1`}
          onChange={(e) => onChange((r) => ({ ...r, note: e.target.value }))}
        />
      </div>

      {rule.action ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-asst-warn/20 px-2.5 py-1.5 text-xs text-asst-text">
          <span>{`English the importer could not read: ${rule.action}`}</span>
          <button type="button" aria-label={`Remove the English of ${label}`} className={`${SMALL_BUTTON} ${FOCUS}`} onClick={() => onChange(withoutAction)}>
            Remove English
          </button>
        </div>
      ) : null}
    </div>
  );
}
