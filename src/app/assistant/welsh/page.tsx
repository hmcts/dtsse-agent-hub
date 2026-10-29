import Link from "next/link";
import { isWelshTask, WELSH_PRODUCTS } from "@/assistant/welsh";
import { WelshPage } from "@/components/assistant/WelshPage";
import { requireViewer } from "@/viewer/current";

export const dynamic = "force-dynamic";

/**
 * The Welsh page: a business analyst's tools for a service's Welsh, run in their own assistant. `?product=` picks the
 * service and `?task=` the task it opens on, so a chat about one service can link straight to its Welsh.
 */
export default async function WelshTranslationsPage({
  searchParams
}: Readonly<{ searchParams: Promise<{ product?: string | string[]; task?: string | string[] }> }>) {
  await requireViewer();
  const { product, task } = await searchParams;
  const initial = WELSH_PRODUCTS.find((p) => p.slug === product)?.slug ?? null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-5 pb-10 pt-7">
        <div className="flex flex-col gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight">Welsh translations</h1>
          <p className="text-pretty text-[13px] text-asst-body">
            Look after a service's Welsh: search its approved translations, find English in its code that has no Welsh, send that to the Welsh Language Unit,
            add what they send back to the catalogue, and put it into the code or a Jira story. Your assistant does each step with your own GitHub and Jira
            sign-ins. It never writes Welsh itself: every word comes from the Welsh Language Unit.
          </p>
        </div>
        <WelshPage products={WELSH_PRODUCTS} initialProduct={initial} initialTask={isWelshTask(task) ? task : null} />
        <p className="text-[13px]">
          <Link href="/assistant" className="text-asst-accent underline hover:text-asst-accent-hover">
            Back to the HMCTS Assistant
          </Link>
        </p>
      </div>
    </div>
  );
}
