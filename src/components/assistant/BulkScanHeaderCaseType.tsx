"use client";

import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { ccdFieldsOf } from "@hmcts-cft/bulk-scan-spec/ccd-match";
import { ccdCounts, withCaseType, withoutCaseType } from "@/bulk-scan/case-type";
import { BulkScanCaseTypePicker } from "@/components/assistant/BulkScanCaseTypePicker";

/**
 * The form header's case type, as one control: the picker, which on a new choice fetches the case type's fields and
 * matches every row again, keeping the CCD ids already set, with the count of case fields the form needs added and rows
 * still to choose.
 */
export function BulkScanHeaderCaseType({
  spec,
  conversationId,
  onSpec
}: Readonly<{
  spec: FormSpec;
  conversationId: string | null;
  onSpec: (update: (current: FormSpec) => FormSpec) => void;
}>) {
  const { ccdCaseTypeId, ccdProduct } = spec.form;
  const counts = ccdCounts(spec);
  const matched = spec.sections.some((s) => s.fields.some((f) => f.ccdMatch));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <BulkScanCaseTypePicker
        conversationId={conversationId}
        selected={ccdCaseTypeId ? { product: ccdProduct ?? "", caseType: ccdCaseTypeId } : null}
        onPicked={(picked) =>
          onSpec((current) =>
            withCaseType(current, { product: picked.product, caseType: picked.caseType, config: picked.config, repo: picked.repo }, ccdFieldsOf(picked.rows))
          )
        }
        onCleared={() => onSpec(withoutCaseType)}
        compact
      />
      {matched ? (
        <p role="status" className="text-[13px] text-asst-body">
          {`${counts.newFields} new case ${counts.newFields === 1 ? "field" : "fields"} to add${counts.unsure > 0 ? `, ${counts.unsure} to choose` : ""}`}
        </p>
      ) : null}
    </div>
  );
}
