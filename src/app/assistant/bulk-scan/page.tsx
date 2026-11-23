import type { Metadata } from "next";
import Link from "next/link";
import { deleteBulkScanSpec } from "@/app/_actions/bulk-scan";
import { BulkScanList } from "@/components/assistant/BulkScanList";
import { BulkScanUpload } from "@/components/assistant/BulkScanUpload";
import { requireViewer } from "@/viewer/current";
import { bulkScanPodConversation, bulkScanSpecs } from "@/web/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Bulk Scan forms" };

/**
 * The Bulk Scan form builder: a paper form's field spec, from a PDF, an Exela SIP or an HMCTS transformation sheet, kept
 * as versions the person edits, simulates and signs off, and turns back into the SIP, the transformation sheet and a
 * service's code. Runs in the hub itself, since nothing in it needs the person's own sign-ins.
 */
export default async function BulkScanFormsPage() {
  const viewer = await requireViewer();
  const [specs, podConversationId] = await Promise.all([bulkScanSpecs(viewer), bulkScanPodConversation(viewer)]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-5 pb-10 pt-7">
        <div className="flex flex-col gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight">Bulk Scan forms</h1>
          <p className="text-pretty text-[13px] text-asst-body">
            Keep one reviewed field list for each paper form, then generate from it the Exela capture sheet, the HMCTS transformation sheet and the service's
            validation and transformation code.
          </p>
        </div>
        <BulkScanUpload podConversationId={podConversationId} />
        <BulkScanList specs={specs} remove={deleteBulkScanSpec} />
        <p className="text-[13px]">
          <Link href="/assistant" className="text-asst-accent underline hover:text-asst-accent-hover">
            Back to CFT Workspace
          </Link>
        </p>
      </div>
    </div>
  );
}
