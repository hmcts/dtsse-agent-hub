import Link from "next/link";
import { requireViewer } from "@/viewer/current";

export const dynamic = "force-dynamic";

/** The Scheduled page: prompts a person's assistant runs on a schedule. It says what is coming until that is built. */
export default async function ScheduledPage() {
  await requireViewer();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-5 pb-10 pt-7">
        <div className="flex flex-col gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight">Scheduled</h1>
          <p className="text-pretty text-[13px] text-asst-body">
            Set a prompt for your assistant to run on a schedule, such as every weekday morning, and read what it found in a chat of its own.
          </p>
        </div>
        <section aria-labelledby="scheduled-coming" className="flex flex-col gap-2 rounded-xl border border-asst-line px-4 py-3.5">
          <h2 id="scheduled-coming" className="text-sm font-semibold">
            Coming soon
          </h2>
          <p className="text-pretty text-[13px] text-asst-body">Scheduled prompts are not available yet.</p>
        </section>
        <p className="text-[13px]">
          <Link href="/assistant" className="text-asst-accent underline hover:text-asst-accent-hover">
            Back to CFT Workspace
          </Link>
        </p>
      </div>
    </div>
  );
}
