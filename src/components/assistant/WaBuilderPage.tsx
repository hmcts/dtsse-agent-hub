import Link from "next/link";
import { LINK } from "@/components/assistant/WaBuilderParts";

/** The frame every builder page has: the same width and spacing as the Welsh page, a title, and the way back. */
export function WaBuilderPage({
  title,
  intro,
  back,
  children
}: Readonly<{ title: string; intro?: string; back: { href: string; label: string }; children: React.ReactNode }>) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <main className="mx-auto flex w-full min-w-0 max-w-[960px] flex-col gap-6 px-5 pb-10 pt-7">
        <div className="flex flex-col gap-2">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          {intro === undefined ? null : <p className="text-pretty text-[13px] text-asst-body">{intro}</p>}
        </div>
        {children}
        <p className="text-[13px]">
          <Link href={back.href} className={LINK}>
            {back.label}
          </Link>
        </p>
      </main>
    </div>
  );
}
