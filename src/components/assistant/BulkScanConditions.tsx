"use client";

import { type Condition, looksTyped, OPERATORS, type Operator } from "@/bulk-scan/edit";
import { FIELD, SECONDARY } from "@/components/assistant/WelshParts";

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
 * Conditions that must all hold, one per row: a key (or sheet id), an operator and, for = and !=, a value. A key is
 * chosen from the form's own, so a condition cannot name one the form does not read.
 */
export function BulkScanConditions({
  label,
  conditions,
  choices,
  onChange
}: Readonly<{ label: string; conditions: readonly Condition[]; choices: readonly KeyChoice[]; onChange: (conditions: Condition[]) => void }>) {
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
        return (
          <div key={condition.key} className="flex flex-wrap items-center gap-1.5">
            <select aria-label={`${label}, condition ${n} key`} value={condition.key} className={FIELD} onChange={(e) => replace(i, { key: e.target.value })}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              aria-label={`${label}, condition ${n} operator`}
              value={condition.op}
              className={FIELD}
              onChange={(e) => replace(i, { op: e.target.value as Operator })}
            >
              {OPERATORS.map(([op, words]) => (
                <option key={op} value={op}>
                  {words}
                </option>
              ))}
            </select>
            {condition.op === "=" || condition.op === "!=" ? (
              <input
                aria-label={`${label}, condition ${n} value`}
                value={condition.value}
                className={`${FIELD} w-40`}
                onChange={(e) => replace(i, { value: e.target.value, typed: false })}
              />
            ) : null}
            {(condition.op === "=" || condition.op === "!=") && looksTyped(condition.value) ? (
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={condition.typed === true} onChange={(e) => replace(i, { typed: e.target.checked })} />
                {`${label}, condition ${n}: ${condition.value} is the value, not the word`}
              </label>
            ) : null}
            <button type="button" className={SECONDARY} onClick={() => onChange(conditions.filter((_, at) => at !== i))}>
              {`Remove ${label}, condition ${n}`}
            </button>
          </div>
        );
      })}
      <div>
        <button type="button" className={SECONDARY} disabled={!added} onClick={() => added && onChange([...conditions, added])}>
          {`Add a condition to ${label}`}
        </button>
      </div>
    </div>
  );
}
