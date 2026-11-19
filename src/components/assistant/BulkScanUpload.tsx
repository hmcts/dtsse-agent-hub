"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { FIELD } from "@/components/assistant/WelshParts";

/** Starts a spec from a form PDF, an Exela SIP or an HMCTS transformation sheet, and opens it. */
export function BulkScanUpload() {
  const router = useRouter();
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ui/assistant/bulk-scan", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) },
        body: file
      });
      const body = (await response.json().catch(() => ({}))) as { ids?: unknown; error?: unknown };
      const first = Array.isArray(body.ids) ? body.ids[0] : undefined;
      if (!response.ok || typeof first !== "string") {
        setError(typeof body.error === "string" ? body.error : "That file could not be uploaded. Try again.");
        return;
      }
      router.push(`/assistant/bulk-scan/${first}`);
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${inputId}-title`} className="flex flex-col gap-2 rounded-xl border border-asst-line px-4 py-3.5">
      <h2 id={`${inputId}-title`} className="text-sm font-semibold">
        Start a form
      </h2>
      <p className="text-pretty text-[13px] text-asst-body">
        Upload the form's PDF to draft its fields, or an Exela SIP or an HMCTS transformation sheet to carry on from one. A PDF needs fillable form fields: for
        a scanned one, ask your assistant to draft it.
      </p>
      <label htmlFor={inputId} className="text-[13px] text-asst-muted">
        PDF or spreadsheet (.pdf, .xlsx)
      </label>
      <input
        id={inputId}
        type="file"
        accept=".pdf,.xlsx"
        disabled={busy}
        className={`${FIELD} max-w-md`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void upload(file);
          }
          event.target.value = "";
        }}
      />
      {busy ? <p className="text-[13px] text-asst-muted">Reading it…</p> : null}
      {error === null ? null : (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      )}
    </section>
  );
}
