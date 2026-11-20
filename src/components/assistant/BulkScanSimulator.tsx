"use client";

import { useState } from "react";
import type { ScenarioEntry } from "@/bulk-scan/spec";
import { FIELD, PRIMARY } from "@/components/assistant/WelshParts";

interface SimulationResult {
  data: Record<string, string>;
  expected: { validation: "success" | "warning" | "exception"; validateOcr: string; transformation: string; basis: string[]; unchecked: string[] };
  case_data: Record<string, unknown>;
}

const TRANSFORMATION: Record<string, string> = {
  "case-created": "A case is created",
  "case-created-with-warnings": "A case is created, carrying the warnings",
  "exception-record": "The transformation answers 422 and the envelope becomes an exception record"
};

const OUTCOME_CLASS = { success: "text-asst-ok", warning: "text-asst-warn", exception: "text-asst-error" } as const;

const KIND_LABEL: Record<string, string> = {
  valid: "Valid",
  "missing-mandatory": "Missing mandatory",
  "invalid-format": "Invalid format",
  "xor-branch": "XoR branches",
  "allowed-value": "Allowed values"
};

async function simulate(specId: string, body: Record<string, unknown>): Promise<SimulationResult | string> {
  try {
    const response = await fetch(`/api/ui/assistant/bulk-scan/${encodeURIComponent(specId)}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const answer = (await response.json().catch(() => ({}))) as Partial<SimulationResult> & { error?: unknown };
    if (!response.ok || !answer.expected || !answer.data) {
      return typeof answer.error === "string" ? answer.error : "That did not work. Try again.";
    }
    return answer as SimulationResult;
  } catch {
    return "That did not work. Check your connection and try again.";
  }
}

/** Runs a sample envelope through the saved version: a generated scenario, or the key and value pairs as edited. */
export function BulkScanSimulator({
  specId,
  version,
  scenarios,
  keys,
  sample
}: Readonly<{ specId: string; version: number; scenarios: readonly ScenarioEntry[]; keys: readonly string[]; sample: Record<string, string> }>) {
  const [values, setValues] = useState<Record<string, string>>(sample);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState("");

  async function run(body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    const answer = await simulate(specId, { version, ...body });
    setBusy(false);
    if (typeof answer === "string") {
      setError(answer);
      return;
    }
    setResult(answer);
    setValues(answer.data);
  }

  const kinds = [...new Set(scenarios.map((s) => s.kind))];
  return (
    <section aria-labelledby="bulk-scan-simulator" className="flex flex-col gap-3">
      <h2 id="bulk-scan-simulator" className="text-sm font-semibold">
        Simulator
      </h2>
      <p className="text-pretty text-[13px] text-asst-body">{`Runs version ${version} as saved. Pick a generated scenario, or change the values below and run them.`}</p>
      <label className="flex max-w-xl flex-col gap-1 text-[13px] text-asst-muted">
        Scenario
        <select
          className={FIELD}
          value={picked}
          disabled={busy}
          onChange={(event) => {
            setPicked(event.target.value);
            if (event.target.value !== "") {
              void run({ scenario: event.target.value });
            }
          }}
        >
          <option value="">Choose a scenario</option>
          {kinds.map((kind) => (
            <optgroup key={kind} label={KIND_LABEL[kind] ?? kind}>
              {scenarios
                .filter((s) => s.kind === kind)
                .map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.description}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <details className="rounded-xl border border-asst-line px-3 py-2">
        <summary className="cursor-pointer text-[13px] font-medium">{`Envelope values (${keys.length} keys)`}</summary>
        <div className="mt-2 max-h-[360px] overflow-y-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <caption className="sr-only">The key and value pairs of the sample envelope</caption>
            <tbody>
              {keys.map((key) => (
                <tr key={key} className="border-b border-asst-line last:border-b-0">
                  <th scope="row" className="w-1/2 py-1 pr-2 text-left font-normal text-asst-muted">
                    {key}
                  </th>
                  <td className="py-1">
                    <input
                      aria-label={`Value of ${key}`}
                      value={values[key] ?? ""}
                      className={`${FIELD} w-full`}
                      onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <div>
        <button type="button" className={PRIMARY} disabled={busy} onClick={() => void run({ data: values })}>
          {busy ? "Running…" : "Run these values"}
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      )}
      {result ? <Outcome result={result} /> : null}
    </section>
  );
}

function Outcome({ result }: Readonly<{ result: SimulationResult }>) {
  const { expected } = result;
  const problems = expected.basis.filter((line) => !line.endsWith(": success"));
  const caseData = Object.entries(result.case_data);
  return (
    <div aria-live="polite" className="flex flex-col gap-3 rounded-xl border border-asst-line px-4 py-3 text-[13px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-asst-muted">Outcome</dt>
        <dd className={`font-semibold ${OUTCOME_CLASS[expected.validation]}`}>{expected.validation}</dd>
        <dt className="text-asst-muted">validate-ocr</dt>
        <dd>{expected.validateOcr}</dd>
        <dt className="text-asst-muted">Transformation</dt>
        <dd>{TRANSFORMATION[expected.transformation] ?? expected.transformation}</dd>
      </dl>
      <div>
        <h3 className="font-medium">Why</h3>
        {problems.length === 0 ? (
          <p className="text-asst-muted">Nothing was flagged.</p>
        ) : (
          <ul className="list-disc pl-4">
            {problems.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {expected.unchecked.length > 0 ? (
          <p className="pt-1 text-asst-muted">{`Not checked, because their rules are English the engine cannot run: ${expected.unchecked.join(", ")}.`}</p>
        ) : null}
      </div>
      <div>
        <h3 className="font-medium">CCD case data</h3>
        {expected.transformation === "exception-record" ? (
          <p className="text-asst-muted">None: the envelope becomes an exception record.</p>
        ) : caseData.length === 0 ? (
          <p className="text-asst-muted">The spec sets no CCD field for these values.</p>
        ) : (
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">CCD fields the spec sets</caption>
            <tbody>
              {caseData.map(([id, value]) => (
                <tr key={id} className="border-b border-asst-line last:border-b-0 align-top">
                  <th scope="row" className="w-1/2 py-1 pr-2 text-left font-normal text-asst-muted">
                    {id}
                  </th>
                  <td className="py-1 break-all">{typeof value === "string" ? value : JSON.stringify(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
