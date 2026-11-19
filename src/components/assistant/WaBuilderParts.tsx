import type { Expr, Model } from "@hmcts-cft/wa-spec";
import Link from "next/link";
import { type ByCaseType, caseTypeLabel, describeExpr, isRawFeel, textParts } from "@/assistant/wa-builder-text";

export const LINK = "text-asst-accent underline hover:text-asst-accent-hover";
const CODE = "whitespace-pre-wrap break-words rounded-sm bg-asst-active px-1.5 py-px font-plex-mono text-[0.9em]";

/** Words with the service's own names set as code. */
export function Words({ text }: Readonly<{ text: string }>) {
  return (
    <>
      {textParts(text).map((part, index) =>
        part.code ? (
          <code key={index} className={CODE}>
            {part.text}
          </code>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </>
  );
}

/** An expression in words, or raw FEEL as a code block. */
export function ExprView({ expr }: Readonly<{ expr: Expr }>) {
  if (isRawFeel(expr)) {
    return (
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling code block must be reachable from the keyboard
      <pre tabIndex={0} className="overflow-x-auto whitespace-pre rounded-lg bg-asst-rail px-3 py-2 font-plex-mono text-[13px] leading-5">
        {expr.feel}
      </pre>
    );
  }
  if (typeof expr === "string") {
    return <span>{expr}</span>;
  }
  return (
    <span>
      <Words text={describeExpr(expr)} />
    </span>
  );
}

/** A table that scrolls sideways, as a region a keyboard can scroll, so a narrow screen never clips a column. */
export function Grid({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable from the keyboard
    <div role="region" aria-label={label} tabIndex={0} className="relative max-w-full min-w-0 overflow-x-auto rounded-lg border border-asst-line">
      <table className="w-full min-w-[480px] border-collapse text-left text-[13px]">
        <caption className="sr-only">{label}</caption>
        {children}
      </table>
    </div>
  );
}

export const TH = "border-b border-asst-line bg-asst-raised px-2.5 py-2 text-xs font-semibold text-asst-text";
export const TD = "border-b border-asst-line px-2.5 py-2 align-top";

/**
 * Content that may differ by case type: shown once when every case type agrees, otherwise once for each group of case
 * types that agree, each named, so a difference is never missed.
 */
export function PerCaseType<T>({ model, groups, children }: Readonly<{ model: Model; groups: Array<ByCaseType<T>>; children: (value: T) => React.ReactNode }>) {
  const [only] = groups;
  if (groups.length === 1 && only) {
    return <>{children(only.value)}</>;
  }
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.caseTypes.join(",")} className="flex flex-col gap-1.5 border-l-2 border-asst-accent-line pl-3">
          <p className="text-xs font-semibold text-asst-accent">Only for {group.caseTypes.map((id) => caseTypeLabel(model, id)).join(", ")}</p>
          {children(group.value)}
        </div>
      ))}
    </div>
  );
}

export function Section({ id, title, children }: Readonly<{ id: string; title: string; children: React.ReactNode }>) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2.5">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export const VIEWS = [
  { id: "setup", label: "Service setup" },
  { id: "roles", label: "Roles and permissions" },
  { id: "tasks", label: "Task board" },
  { id: "lifecycle", label: "Case lifecycle" },
  { id: "simulator", label: "Simulator" }
] as const;
export type WaView = (typeof VIEWS)[number]["id"];

export const isWaView = (value: string | undefined): value is WaView => VIEWS.some((view) => view.id === value);

/** The views of one service, as links so each has an address and works without scripts. */
export function ViewTabs({ service, current, version }: Readonly<{ service: string; current: WaView | null; version?: number }>) {
  const suffix = version === undefined ? "" : `&version=${version}`;
  return (
    <nav aria-label="Views of this service">
      <ul className="flex flex-wrap gap-1.5">
        {VIEWS.map((view) => (
          <li key={view.id}>
            <Link
              href={`/assistant/wa-builder/${encodeURIComponent(service)}?view=${view.id}${suffix}`}
              aria-current={current === view.id ? "page" : undefined}
              className={`inline-flex rounded-[10px] border px-3 py-1.5 text-[13px] hover:bg-asst-hover ${current === view.id ? "border-asst-accent bg-asst-active font-semibold text-asst-text" : "border-asst-line text-asst-body"}`}
            >
              {view.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A view that is built in a later stage: it says so and shows nothing in its place. */
export function Placeholder({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <Section id="wa-placeholder" title={title}>
      <p className="rounded-xl border border-dashed border-asst-line px-4 py-3.5 text-[13px] text-asst-muted">{children}</p>
    </Section>
  );
}
