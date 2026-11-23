import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { signOffSpec } from "@/app/_actions/bulk-scan";
import { versionOf } from "@/bulk-scan/spec";
import { BulkScanEditor } from "@/components/assistant/BulkScanEditor";
import { requireViewer } from "@/viewer/current";
import { bulkScanEditor } from "@/web/data";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
  searchParams
}: Readonly<{ params: Promise<{ id: string }>; searchParams: Promise<{ version?: string | string[] }> }>): Promise<Metadata> {
  const [{ id }, { version }] = await Promise.all([params, searchParams]);
  const view = await bulkScanEditor(await requireViewer(), id, versionOf(Array.isArray(version) ? version[0] : version));
  return { title: view?.name.trim() || "Bulk Scan form" };
}

/** One of the person's Bulk Scan specs at its latest version, or `?version=n`. Anyone else's reads as missing. */
export default async function BulkScanSpecPage({
  params,
  searchParams
}: Readonly<{ params: Promise<{ id: string }>; searchParams: Promise<{ version?: string | string[] }> }>) {
  const viewer = await requireViewer();
  const [{ id }, { version }] = await Promise.all([params, searchParams]);
  const view = await bulkScanEditor(viewer, id, versionOf(Array.isArray(version) ? version[0] : version));
  if (!view) {
    notFound();
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-5 pb-10 pt-7">
        <h1 className="text-[22px] font-semibold tracking-tight">{view.name}</h1>
        <BulkScanEditor key={`${view.id}:${view.version}`} view={view} signOff={signOffSpec} />
        <p className="text-[13px]">
          <Link href="/assistant/bulk-scan" className="text-asst-accent underline hover:text-asst-accent-hover">
            Back to Bulk Scan forms
          </Link>
        </p>
      </div>
    </div>
  );
}
