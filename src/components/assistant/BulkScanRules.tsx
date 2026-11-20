"use client";

import type { Field, Outcome, Rule } from "@hmcts-cft/bulk-scan-spec";
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
import { FIELD, SECONDARY } from "@/components/assistant/WelshParts";

const OUTCOMES: readonly Outcome[] = ["success", "warning", "exception"];

/**
 * A field's rules: an ordered list of branches. Each has conditions that must all hold, optional OR alternatives, the
 * CCD fields it sets, an outcome and a note, and may be the ELSE of the branch before it or start a chain of its own.
 */
export function BulkScanRules({
  field,
  name,
  conditionChoices,
  keyChoices,
  ccdChoices,
  onChange
}: Readonly<{
  field: Field;
  name: string;
  conditionChoices: readonly KeyChoice[];
  keyChoices: readonly KeyChoice[];
  ccdChoices: readonly string[];
  onChange: (field: Field) => void;
}>) {
  return (
    <div className="flex flex-col gap-2">
      {field.rules.map((rule, i) => (
        // A branch has no identity but its place in the list, which is what its controls change.
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-asst-line p-2.5">
          <RuleBranch
            label={`branch ${i + 1} of ${name}`}
            rule={rule}
            first={i === 0}
            conditionChoices={conditionChoices}
            keyChoices={keyChoices}
            ccdChoices={ccdChoices}
            onChange={(change) => onChange(mapRule(field, i, change))}
          />
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={SECONDARY} disabled={i === 0} onClick={() => onChange(moveRule(field, i, -1))}>
              {`Move branch ${i + 1} of ${name} up`}
            </button>
            <button type="button" className={SECONDARY} disabled={i === field.rules.length - 1} onClick={() => onChange(moveRule(field, i, 1))}>
              {`Move branch ${i + 1} of ${name} down`}
            </button>
            <button type="button" className={SECONDARY} onClick={() => onChange(removeRule(field, i))}>
              {`Remove branch ${i + 1} of ${name}`}
            </button>
          </div>
        </div>
      ))}
      <div>
        <button type="button" className={SECONDARY} onClick={() => onChange(addRule(field))}>
          {`Add a branch to ${name}`}
        </button>
      </div>
    </div>
  );
}

function RuleBranch({
  label,
  rule,
  first,
  conditionChoices,
  keyChoices,
  ccdChoices,
  onChange
}: Readonly<{
  label: string;
  rule: Rule;
  first: boolean;
  conditionChoices: readonly KeyChoice[];
  keyChoices: readonly KeyChoice[];
  ccdChoices: readonly string[];
  onChange: (change: (rule: Rule) => Rule) => void;
}>) {
  const groups = groupsOf(rule);
  const assignments = assignmentsOf(rule);
  const setRows = (rows: AssignmentRow[]) => onChange((r) => withAssignments(r, rows));
  const freeTarget = ccdChoices.find((c) => !assignments.some((a) => a.target === c));
  return (
    <>
      <div className="flex flex-wrap gap-4 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={rule.otherwise === true} onChange={(e) => onChange((r) => withElse(r, e.target.checked))} />
          {`ELSE: ${label}`}
        </label>
        {first ? null : (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={rule.independent === true} onChange={(e) => onChange((r) => ({ ...r, independent: e.target.checked }))} />
            {`Starts a new chain: ${label}`}
          </label>
        )}
      </div>
      {rule.otherwise ? null : (
        <div className="flex flex-col gap-1.5">
          {groups.map((group, g) => (
            <div key={g} className="flex flex-col gap-1.5">
              {g > 0 ? <span className="text-xs font-semibold">OR</span> : null}
              <BulkScanConditions
                label={groups.length > 1 ? `${label}, alternative ${g + 1}` : label}
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
          {groups.length === 0 ? (
            <button
              type="button"
              className={SECONDARY}
              disabled={!nextCondition([], conditionChoices)}
              onClick={() => {
                const first = nextCondition([], conditionChoices);
                if (first) {
                  onChange((r) => withGroups(r, [[first]]));
                }
              }}
            >
              {`Add a condition to ${label}`}
            </button>
          ) : (
            <div>
              <button
                type="button"
                className={SECONDARY}
                disabled={!nextCondition([], conditionChoices)}
                onClick={() => {
                  const first = nextCondition([], conditionChoices);
                  if (first) {
                    onChange((r) => withGroups(r, [...groups, [first]]));
                  }
                }}
              >
                {`Add an OR alternative to ${label}`}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {assignments.map((row, i) => {
          const replace = (patch: Partial<AssignmentRow>) => setRows(assignments.map((a, at) => (at === i ? { ...a, ...patch } : a)));
          const targets = [...new Set([...ccdChoices.filter((c) => c === row.target || !assignments.some((a) => a.target === c)), row.target])];
          return (
            <div key={row.target} className="flex flex-wrap items-center gap-1.5">
              <select
                aria-label={`${label}, assignment ${i + 1} CCD field`}
                value={row.target}
                className={FIELD}
                onChange={(e) => replace({ target: e.target.value })}
              >
                {targets.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <span>=</span>
              <select
                aria-label={`${label}, assignment ${i + 1} kind`}
                value={row.copy ? "copy" : "value"}
                className={FIELD}
                onChange={(e) => replace(e.target.value === "copy" ? { copy: true, value: keyChoices[0]?.value ?? "" } : { copy: false, value: "" })}
              >
                <option value="value">the value</option>
                <option value="copy">a copy of the key</option>
              </select>
              {row.copy ? (
                <select
                  aria-label={`${label}, assignment ${i + 1} key`}
                  value={row.value}
                  className={FIELD}
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
                  className={`${FIELD} w-40`}
                  onChange={(e) => replace({ value: e.target.value, typed: false })}
                />
              )}
              {!row.copy && looksTyped(row.value) ? (
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={row.typed === true} onChange={(e) => replace({ typed: e.target.checked })} />
                  {`${label}, assignment ${i + 1}: ${row.value} is the value, not the word`}
                </label>
              ) : null}
              <button type="button" className={SECONDARY} onClick={() => setRows(assignments.filter((_, at) => at !== i))}>
                {`Remove ${label}, assignment ${i + 1}`}
              </button>
            </div>
          );
        })}
        <div>
          <button
            type="button"
            className={SECONDARY}
            disabled={freeTarget === undefined}
            title={ccdChoices.length === 0 ? "Give a row a CCD id first" : undefined}
            onClick={() => freeTarget && setRows([...assignments, { target: freeTarget, copy: false, value: "" }])}
          >
            {`Add an assignment to ${label}`}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs">
          Outcome
          <select
            aria-label={`Outcome of ${label}`}
            value={rule.outcome ?? ""}
            className={FIELD}
            onChange={(e) => onChange((r) => ({ ...r, outcome: (e.target.value || undefined) as Outcome | undefined }))}
          >
            <option value="">none</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <input
          aria-label={`Note of ${label}`}
          placeholder="Note"
          value={rule.note ?? ""}
          className={`${FIELD} min-w-[240px] flex-1`}
          onChange={(e) => onChange((r) => ({ ...r, note: e.target.value }))}
        />
      </div>
      {rule.action ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-asst-muted">
          <span>{`English the importer could not read: ${rule.action}`}</span>
          <button type="button" className={SECONDARY} onClick={() => onChange(withoutAction)}>
            {`Remove the English of ${label}`}
          </button>
        </div>
      ) : null}
    </>
  );
}
