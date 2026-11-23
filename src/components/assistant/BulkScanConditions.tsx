"use client";

import { type Condition, looksTyped, OPERATORS, type Operator } from "@/bulk-scan/edit";
import { AddButton, IconButton, INPUT } from "@/components/assistant/BulkScanParts";

export interface KeyChoice {
  value: string;
  label: string;
}

/** The first key a new condition can test: one this list does not test yet. */
export function nextCondition(conditions: readonly Condition[], choices: readonly KeyChoice[]): Condition | undefined {
  const free = choices.find((c) => !conditions.some((x) => x.key === c.value));
  return free ? { key: free.value, op: "=", value: "" } : undefined;
}

/**
 * Conditions that must all hold, one per line: the lead word (When, Mandatory if, OR) on the first and AND after it, then
 * a key (or sheet id), an operator and, for = and !=, a value. A key is chosen from the form's own, so a condition
 * cannot name one the form does not read.
 */
export function BulkScanConditions({
  label,
  lead,
  conditions,
  choices,
  onChange
}: Readonly<{ label: string; lead: string; conditions: readonly Condition[]; choices: readonly KeyChoice[]; onChange: (conditions: Condition[]) => void }>) {
  const replace = (at: number, patch: Partial<Condition>) => onChange(conditions.map((c, i) => (i === at ? { ...c, ...patch } : c)));
  const added = nextCondition(conditions, choices);
  return (
    <div className="flex flex-col gap-1.5">
      {conditions.map((condition, i) => {
        const options = [
          ...choices.filter((c) => c.value === condition.key || !conditions.some((x) => x.key === c.value)),
          ...(choices.some((c) => c.value === condition.key) ? [] : [{ value: condition.key, label: condition.key }])
        ];
        const n = i + 1;
        const compares = condition.op === "=" || condition.op === "!=";
        return (
          <div key={condition.key} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-asst-muted">{i === 0 ? lead : "and"}</span>
              <select
                aria-label={`${label}, condition ${n} key`}
                value={condition.key}
                className={`${INPUT} w-auto max-w-[16rem]`}
                onChange={(e) => replace(i, { key: e.target.value })}
              >
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                aria-label={`${label}, condition ${n} operator`}
                value={condition.op}
                className={`${INPUT} w-auto`}
                onChange={(e) => replace(i, { op: e.target.value as Operator })}
              >
                {OPERATORS.map(([op, words]) => (
                  <option key={op} value={op}>
                    {words}
                  </option>
                ))}
              </select>
              {compares ? (
                <input
                  aria-label={`${label}, condition ${n} value`}
                  value={condition.value}
                  className={`${INPUT} w-40`}
                  onChange={(e) => replace(i, { value: e.target.value, typed: false })}
                />
              ) : null}
              <IconButton label={`Remove ${label}, condition ${n}`} icon="remove" onClick={() => onChange(conditions.filter((_, at) => at !== i))} />
            </div>
            {compares && looksTyped(condition.value) ? (
              <label className="ml-24 flex items-center gap-1.5 pl-1.5 text-xs text-asst-body">
                <input
                  type="checkbox"
                  aria-label={`${label}, condition ${n}: ${condition.value} is the value, not the word`}
                  checked={condition.typed === true}
                  onChange={(e) => replace(i, { typed: e.target.checked })}
                />
                {`${condition.value} is the value, not the word`}
              </label>
            ) : null}
          </div>
        );
      })}
      <div className="pl-[6.375rem]">
        <AddButton label={`Add a condition to ${label}`} text="Add a condition" disabled={!added} onClick={() => added && onChange([...conditions, added])} />
      </div>
    </div>
  );
}
