"use client";

import Link from "next/link";
import { useState } from "react";
import type { VersionEntry } from "@/bulk-scan/spec-store";
import { PRIMARY } from "@/components/assistant/WelshParts";
import type { ActionResult } from "@/web/action";
import { actionThrew } from "@/web/action-fault";

export type SignOffAction = (form: FormData) => Promise<ActionResult<{ confirmation: string }>>;

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Every saved version, who saved it, and who signed it off; the one being viewed can be signed off here. */
export function BulkScanVersions({
  specId,
  viewing,
  versions,
  signOff
}: Readonly<{ specId: string; viewing: number; versions: readonly VersionEntry[]; signOff: SignOffAction }>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = versions.find((v) => v.version === viewing);

  async function sign(): Promise<void> {
    const form = new FormData();
    form.set("id", specId);
    form.set("version", String(viewing));
    setBusy(true);
    try {
      const result = await signOff(form);
      setError(result.ok ? null : result.error);
    } catch (thrown) {
      setError(actionThrew(thrown));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="bulk-scan-versions" className="flex flex-col gap-2">
      <h2 id="bulk-scan-versions" className="text-sm font-semibold">
        Versions and sign-off
      </h2>
      <ul className="flex flex-col divide-y divide-asst-line rounded-xl border border-asst-line text-[13px]">
        {versions.map((v) => (
          <li key={v.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
            {v.version === viewing ? (
              <span className="font-semibold">{`Version ${v.version} (viewing)`}</span>
            ) : (
              <Link href={`/assistant/bulk-scan/${specId}?version=${v.version}`} className="text-asst-accent underline hover:text-asst-accent-hover">
                {`Version ${v.version}`}
              </Link>
            )}
            <span className="text-asst-muted">{`Saved by ${v.savedBy}, ${when(v.savedAt)}`}</span>
            {v.signedOffAt && v.signedOffBy ? <span className="text-asst-ok">{`Signed off by ${v.signedOffBy}, ${when(v.signedOffAt)}`}</span> : null}
          </li>
        ))}
      </ul>
      {current && current.signedOffAt === null ? (
        <div className="flex flex-col items-start gap-1.5">
          <p className="text-pretty text-[13px] text-asst-body">
            {`Signing off records that you have checked version ${viewing}: its fields, rules and CCD mapping. It stays as it is; a change is saved as a new version, which needs signing off again.`}
          </p>
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => void sign()}>
            {`Sign off version ${viewing}`}
          </button>
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      )}
    </section>
  );
}
