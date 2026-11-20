"use client";

import Link from "next/link";
import { useState } from "react";
import type { SpecSummary } from "@/bulk-scan/spec-store";
import { SECONDARY } from "@/components/assistant/WelshParts";
import type { ActionResult } from "@/web/action";
import { actionThrew } from "@/web/action-fault";

export type DeleteSpecAction = (form: FormData) => Promise<ActionResult<{ confirmation: string }>>;

/** The person's specs, newest first, each with the version it is at and whether that version is signed off. */
export function BulkScanList({ specs, remove }: Readonly<{ specs: readonly SpecSummary[]; remove: DeleteSpecAction }>) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function deleteSpec(id: string): Promise<void> {
    const form = new FormData();
    form.set("id", id);
    let result: ActionResult<{ confirmation: string }>;
    try {
      result = await remove(form);
    } catch (thrown) {
      setError(actionThrew(thrown));
      return;
    }
    setConfirming(null);
    setError(result.ok ? null : result.error);
  }

  if (specs.length === 0) {
    return <p className="text-[13px] text-asst-muted">You have no forms yet. Start one above.</p>;
  }
  return (
    <section aria-labelledby="bulk-scan-forms" className="flex flex-col gap-2">
      <h2 id="bulk-scan-forms" className="text-sm font-semibold">
        Your forms
      </h2>
      <ul className="flex flex-col divide-y divide-asst-line rounded-xl border border-asst-line">
        {specs.map((spec) => (
          <li key={spec.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
            <Link
              href={`/assistant/bulk-scan/${spec.id}`}
              className="min-w-0 flex-1 truncate font-medium text-asst-accent underline hover:text-asst-accent-hover"
            >
              {spec.name}
            </Link>
            <span className="text-asst-muted">
              {`Version ${spec.version}, saved ${new Date(spec.savedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`}
            </span>
            <span className={spec.signedOff ? "text-asst-ok" : "text-asst-muted"}>{spec.signedOff ? "Signed off" : "Not signed off"}</span>
            {confirming === spec.id ? (
              <button type="button" className={SECONDARY} onClick={() => void deleteSpec(spec.id)}>
                {`Delete ${spec.name} and all its versions`}
              </button>
            ) : (
              <button type="button" className={SECONDARY} onClick={() => setConfirming(spec.id)}>
                {`Delete ${spec.name}`}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error === null ? null : (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      )}
    </section>
  );
}
