"use client";

import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clearReview, issuesByField, patchHeader, reviewChecklist } from "@/bulk-scan/edit";
import type { BulkScanEditorView } from "@/bulk-scan/editor-view";
import { BulkScanDownloads } from "@/components/assistant/BulkScanDownloads";
import { BulkScanFields } from "@/components/assistant/BulkScanFields";
import { BulkScanSimulator } from "@/components/assistant/BulkScanSimulator";
import { BulkScanVersions, type SignOffAction } from "@/components/assistant/BulkScanVersions";
import { FIELD, PRIMARY, SECONDARY } from "@/components/assistant/WelshParts";

/**
 * One spec: its form details, its fields, a save that makes the next version, and below those the simulator, the
 * downloads and the sign-off, which all work on the version saved. The page keys this on the spec and version, so a save
 * or a change of version starts it afresh from what was stored.
 */
export function BulkScanEditor({ view, signOff }: Readonly<{ view: BulkScanEditorView; signOff: SignOffAction }>) {
  const router = useRouter();
  const [spec, setSpec] = useState<FormSpec>(view.spec);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<ReturnType<typeof issuesByField>>({ fields: new Map(), form: [] });
  const [error, setError] = useState<string | null>(null);
  const checklist = reviewChecklist(spec);
  const latest = Math.max(...view.versions.map((v) => v.version));
  const superseded = view.version !== latest;

  function change(next: FormSpec, moved = false): void {
    setSpec(next);
    setDirty(true);
    if (moved) {
      setProblems({ fields: new Map(), form: problems.form });
    }
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/ui/assistant/bulk-scan/${encodeURIComponent(view.id)}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseVersion: view.version, spec })
      });
      const body = (await response.json().catch(() => ({}))) as { version?: unknown; issues?: { path: string; message: string }[]; error?: unknown };
      if (response.ok && typeof body.version === "number") {
        setProblems({ fields: new Map(), form: [] });
        router.push(`/assistant/bulk-scan/${view.id}`);
        router.refresh();
        return;
      }
      setProblems(issuesByField(body.issues ?? []));
      const marked = (body.issues ?? []).length > 0 ? ", marked in the rows below" : "";
      setError(typeof body.error === "string" ? `${body.error}${marked}` : "That did not save. Try again.");
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="bulk-scan-form" className="flex flex-col gap-3">
        <h2 id="bulk-scan-form" className="text-sm font-semibold">
          {`Form (version ${view.version})`}
        </h2>
        <div className="flex flex-wrap gap-3 text-[13px] text-asst-muted">
          <HeaderField label="Form name" value={spec.form.name} onChange={(name) => change(patchHeader(spec, { name }))} className="min-w-[240px] flex-1" />
          <HeaderField
            label="Form type (document_sub_type)"
            value={spec.form.formType}
            onChange={(formType) => change(patchHeader(spec, { formType }))}
            className="w-56"
          />
          <HeaderField label="PO box" value={spec.form.poBox ?? ""} onChange={(poBox) => change(patchHeader(spec, { poBox }))} className="w-40" />
          <HeaderField
            label="Case type (CCD case type id)"
            value={spec.form.ccdCaseTypeId ?? ""}
            onChange={(caseType) => change(patchHeader(spec, { ccdCaseTypeId: caseType }))}
            className="w-64"
          />
        </div>
      </section>

      {checklist.length > 0 ? (
        <section aria-labelledby="bulk-scan-checklist" className="flex flex-col gap-2">
          <h2 id="bulk-scan-checklist" className="text-sm font-semibold">
            {`Review checklist (${checklist.length} guesses, lowest confidence first)`}
          </h2>
          <p className="text-[13px] text-asst-body">
            Each of these was guessed from the PDF. Rules are not proposed at all. Mark one done once you have checked it.
          </p>
          <ul className="flex max-h-[240px] list-disc flex-col gap-1 overflow-y-auto pl-5 text-[13px]">
            {checklist.map((line) => (
              <li key={`${line.at}-${line.about}-${line.reason}`}>
                {`[${line.confidence}] ${line.where}: ${line.about}, ${line.reason} `}
                <button type="button" className={SECONDARY} onClick={() => change(clearReview(spec, line.section, line.field, line.index))}>
                  {`Done: ${line.where} ${line.about}`}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="bulk-scan-fields" className="flex flex-col gap-3">
        <h2 id="bulk-scan-fields" className="text-sm font-semibold">
          Fields
        </h2>
        <p className="text-pretty text-[13px] text-asst-body">
          Change a field in its row and under it, add or move rows and sections, then save a new version.
        </p>
        <BulkScanFields spec={spec} issues={problems.fields} onSpec={change} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={PRIMARY} disabled={saving || !dirty || superseded} onClick={() => void save()}>
            {saving ? "Saving…" : "Save as a new version"}
          </button>
          {superseded ? (
            <span className="text-[13px] text-asst-muted">{`This is not the latest version: open version ${latest} to change it.`}</span>
          ) : dirty ? (
            <span className="text-[13px] text-asst-muted">You have changes that are not saved. The simulator and downloads below use the saved version.</span>
          ) : null}
        </div>
        {error === null && problems.form.length === 0 ? null : (
          <div role="alert" className="text-[13px] text-asst-error">
            {error ? <p>{error}</p> : null}
            {problems.form.length > 0 ? (
              <ul className="list-disc pl-5">
                {problems.form.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      {view.simulatorProblem === null ? (
        <BulkScanSimulator specId={view.id} version={view.version} scenarios={view.scenarios} keys={view.keys} sample={view.sample} />
      ) : (
        <p role="alert" className="text-[13px] text-asst-error">{`The simulator cannot run this version: ${view.simulatorProblem}`}</p>
      )}
      <BulkScanDownloads specId={view.id} version={view.version} targets={view.targets} />
      <BulkScanVersions specId={view.id} viewing={view.version} versions={view.versions} signOff={signOff} />
    </div>
  );
}

function HeaderField({ label, value, onChange, className }: Readonly<{ label: string; value: string; onChange: (value: string) => void; className: string }>) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      {label}
      <input value={value} className={FIELD} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
