"use client";

import type { FormSpec } from "@hmcts-cft/bulk-scan-spec";
import { ccdFieldsOf } from "@hmcts-cft/bulk-scan-spec/ccd-match";
import { useState } from "react";
import { ccdCounts, withCaseType, withoutCaseType } from "@/bulk-scan/case-type";
import { patchHeader } from "@/bulk-scan/edit";
import { BulkScanCaseTypePicker, type ListedCaseTypes } from "@/components/assistant/BulkScanCaseTypePicker";
import { BulkScanTypedCaseType } from "@/components/assistant/BulkScanTypedCaseType";

/** Why the typed id is offered, in a few words: the list cannot be read, or it lacks the case type the form has. */
function typedReason(list: ListedCaseTypes, spec: FormSpec): string | null {
  const { ccdCaseTypeId, ccdProduct } = spec.form;
  if (list.state === "none") {
    return "Your assistant is not available to list your workspace's case types.";
  }
  if (list.state === "failed") {
    return "Your workspace's case types could not be listed.";
  }
  if (ccdCaseTypeId && ccdProduct === undefined) {
    return "This case type was typed, not picked from your workspace.";
  }
  if (list.state === "ready" && ccdCaseTypeId && !list.types.some((t) => t.case_type === ccdCaseTypeId)) {
    return "This case type is not in your workspace's list.";
  }
  return null;
}

/**
 * The form header's case type, as one control: the picker, which on a new choice fetches the case type's fields and
 * matches every row again, keeping the CCD ids already set, with the count of case fields the form needs added and rows
 * still to choose. A case type id can be typed instead only where the picker cannot list case types or lacks the form's.
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
  const [list, setList] = useState<ListedCaseTypes>({ state: conversationId === null ? "none" : "idle", types: [] });
  const [fetching, setFetching] = useState(false);
  const counts = ccdCounts(spec);
  const matched = spec.sections.some((s) => s.fields.some((f) => f.ccdMatch));
  const reason = typedReason(list, spec);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <BulkScanCaseTypePicker
        conversationId={conversationId}
        selected={ccdCaseTypeId && ccdProduct ? { product: ccdProduct, caseType: ccdCaseTypeId } : null}
        onPicked={(picked) =>
          onSpec((current) =>
            withCaseType(current, { product: picked.product, caseType: picked.caseType, config: picked.config, repo: picked.repo }, ccdFieldsOf(picked.rows))
          )
        }
        onCleared={() => onSpec(withoutCaseType)}
        onFetching={setFetching}
        onList={setList}
      />
      {matched ? (
        <p role="status" className="text-[13px] text-asst-body">
          {`${counts.newFields} new case ${counts.newFields === 1 ? "field" : "fields"} to add${counts.unsure > 0 ? `, ${counts.unsure} to choose` : ""}`}
        </p>
      ) : null}
      <BulkScanTypedCaseType
        value={ccdCaseTypeId ?? ""}
        reason={reason}
        disabled={fetching}
        onChange={(typed) =>
          onSpec((current) => patchHeader(current.form.ccdProduct === undefined ? current : withoutCaseType(current), { ccdCaseTypeId: typed }))
        }
      />
    </div>
  );
}
