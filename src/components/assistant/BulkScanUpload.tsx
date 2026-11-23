"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { BulkScanCaseTypePicker, type PickedCaseType } from "@/components/assistant/BulkScanCaseTypePicker";
import { FIELD } from "@/components/assistant/WelshParts";

/** Starts a spec from a form PDF, an Exela SIP or an HMCTS transformation sheet, and opens it. */
export function BulkScanUpload({ podConversationId = null }: Readonly<{ podConversationId?: string | null }>) {
  const router = useRouter();
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<File | null>(null);
  const [picked, setPicked] = useState<PickedCaseType | null>(null);

  async function upload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (form === null) {
      setError("Choose the form to upload.");
      return;
    }
    const body = new FormData();
    body.set("form", form);
    if (picked !== null) {
      body.set("caseType", picked.caseType);
      body.set("product", picked.product);
      body.set("config", picked.config ?? "");
      body.set("fields", JSON.stringify(picked.rows));
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ui/assistant/bulk-scan", { method: "POST", body });
      const result = (await response.json().catch(() => ({}))) as { ids?: unknown; error?: unknown };
      const first = Array.isArray(result.ids) ? result.ids[0] : undefined;
      if (!response.ok || typeof first !== "string") {
        setError(typeof result.error === "string" ? result.error : "That file could not be uploaded. Try again.");
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
      <form method="post" onSubmit={(event) => void upload(event)} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-[13px] text-asst-muted">
          Form: PDF or spreadsheet (.pdf, .xlsx)
        </label>
        <input
          id={inputId}
          name="form"
          type="file"
          accept=".pdf,.xlsx"
          disabled={busy}
          onChange={(event) => setForm(event.target.files?.[0] ?? null)}
          className={`${FIELD} max-w-md`}
        />
        <BulkScanCaseTypePicker
          conversationId={podConversationId}
          selected={picked === null ? null : { product: picked.product, caseType: picked.caseType }}
          onPicked={setPicked}
          onCleared={() => setPicked(null)}
          disabled={busy}
        />
        <button type="submit" disabled={busy} className="w-fit rounded-lg border border-asst-line px-3 py-1.5 text-[13px] font-medium">
          Start the form
        </button>
      </form>
      {busy ? <p className="text-[13px] text-asst-muted">Reading it…</p> : null}
      {error === null ? null : (
        <p role="alert" className="text-[13px] text-asst-error">
          {error}
        </p>
      )}
    </section>
  );
}
