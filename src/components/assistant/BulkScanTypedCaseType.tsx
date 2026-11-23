"use client";

import { INPUT } from "@/components/assistant/BulkScanParts";

/**
 * A case type id typed by hand, offered under the picker whatever the picker holds, since its list may lack the one
 * wanted. Open when the picker cannot be used or cannot show the form's case type (`reason` says why), closed otherwise.
 */
export function BulkScanTypedCaseType({
  value,
  reason,
  disabled = false,
  onChange
}: Readonly<{ value: string; reason: string | null; disabled?: boolean; onChange: (value: string) => void }>) {
  return (
    <details open={reason !== null} className="text-[13px]">
      <summary className="w-fit cursor-pointer text-asst-muted hover:text-asst-text">Or type a case type id</summary>
      <div className="mt-1.5 flex flex-col gap-1">
        <input aria-label="Or type a case type id" value={value} disabled={disabled} className={INPUT} onChange={(e) => onChange(e.target.value)} />
        {reason === null ? null : <p className="text-xs text-asst-muted">{reason}</p>}
      </div>
    </details>
  );
}
