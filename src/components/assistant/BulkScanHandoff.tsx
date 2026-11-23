"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { DEFAULT_JAVA_PACKAGE, defaultHandoffTarget, HANDOFF_TARGETS, JAVA_TARGETS, NO_FORM_TYPE, NOT_SIGNED_OFF } from "@/bulk-scan/handoff";
import { FIELD, PRIMARY } from "@/components/assistant/WelshParts";
import type { ActionResult } from "@/web/action";
import { actionThrew } from "@/web/action-fault";

export type HandToAssistantAction = (form: FormData) => Promise<ActionResult<{ id: string }>>;

/**
 * Starts a new Assistant conversation for the signed-off version being viewed, with its generated code, spec and
 * transformation sheet attached and the request for the service's draft PR written, then opens it. Off, with the
 * reason, for a version that is not signed off: the one that was reviewed is the one handed over.
 */
export function BulkScanHandoff({
  specId,
  version,
  signedOff,
  formType,
  ccdCaseTypeId,
  ccdProduct,
  handToAssistant
}: Readonly<{
  specId: string;
  version: number;
  signedOff: boolean;
  formType: string;
  ccdCaseTypeId: string | undefined;
  ccdProduct: string | undefined;
  handToAssistant: HandToAssistantAction;
}>) {
  const router = useRouter();
  const reason = useId();
  const typeReason = useId();
  const typed = formType.trim() !== "";
  const [target, setTarget] = useState<string>(defaultHandoffTarget({ ccdCaseTypeId, ccdProduct }));
  const [javaPackage, setJavaPackage] = useState(DEFAULT_JAVA_PACKAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function hand(): Promise<void> {
    const form = new FormData();
    form.set("id", specId);
    form.set("version", String(version));
    form.set("target", target);
    if (JAVA_TARGETS.includes(target)) {
      form.set("package", javaPackage);
    }
    setBusy(true);
    setError(null);
    try {
      const result = await handToAssistant(form);
      if (result.ok) {
        router.push(`/assistant/${result.id}`);
        return;
      }
      setError(result.error);
    } catch (thrown) {
      setError(actionThrew(thrown));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="bulk-scan-handoff" className="flex flex-col gap-2">
      <h2 id="bulk-scan-handoff" className="text-sm font-semibold">
        Hand to the Assistant
      </h2>
      <p className="text-pretty text-[13px] text-asst-body">
        {`Starts a new chat with version ${version}'s code, spec and transformation sheet attached, asking for a draft PR in the service's repository and the orchestrator's surname mapping as another.`}
      </p>
      <div className="flex flex-wrap items-end gap-3 text-[13px]">
        <label className="flex flex-col gap-1 text-asst-muted">
          Code pattern
          <select className={FIELD} value={target} onChange={(event) => setTarget(event.target.value)}>
            {HANDOFF_TARGETS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {JAVA_TARGETS.includes(target) ? (
          <label className="flex flex-col gap-1 text-asst-muted">
            Java package
            <input className={`${FIELD} w-72`} value={javaPackage} onChange={(event) => setJavaPackage(event.target.value)} />
          </label>
        ) : null}
        <button
          type="button"
          className={PRIMARY}
          disabled={!signedOff || !typed || busy}
          aria-describedby={[signedOff ? null : reason, typed ? null : typeReason].filter((id) => id !== null).join(" ") || undefined}
          onClick={() => void hand()}
        >
          {busy ? "Handing over…" : "Hand to the Assistant"}
        </button>
      </div>
      {signedOff ? null : (
        <p id={reason} className="text-[13px] text-asst-muted">
          {NOT_SIGNED_OFF}
        </p>
      )}
      {typed ? null : (
        <p id={typeReason} className="text-[13px] text-asst-muted">
          {NO_FORM_TYPE}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      )}
    </section>
  );
}
