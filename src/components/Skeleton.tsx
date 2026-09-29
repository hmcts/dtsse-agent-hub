import { Panel } from "@/components/Section";

/**
 * The bones of a page for each route's `loading.tsx`. One `role="status"` says loading in words; the bars are
 * hidden from screen readers.
 */
export function SkeletonPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <p role="status" className="sr-only">
        Loading
      </p>
      <div aria-hidden="true" className="space-y-6">
        {children}
      </div>
    </div>
  );
}

export function SkeletonBar({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-slate-800 ${className}`} />;
}

export function SkeletonSection({ rows }: { rows: number }) {
  return (
    <Panel>
      <div className="flex items-baseline gap-x-3 border-b border-slate-800 px-4 py-3">
        <SkeletonBar className="h-4 w-32" />
        <SkeletonBar className="h-3 w-40" />
      </div>
      <div className="space-y-3 p-4">
        {Array.from({ length: rows }, (_, index) => (
          <SkeletonBar key={index} className="h-4 w-full" />
        ))}
      </div>
    </Panel>
  );
}

/** A page heading over one section: every route's first paint has this shape. */
export function SkeletonList({ rows }: { rows: number }) {
  return (
    <SkeletonPage>
      <SkeletonBar className="h-7 w-64 max-w-full" />
      <SkeletonSection rows={rows} />
    </SkeletonPage>
  );
}
