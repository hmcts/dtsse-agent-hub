/**
 * The bones of a page for each route's `loading.tsx`. One `role="status"` says loading in words; the bars are
 * hidden from screen readers.
 */
export function SkeletonPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p role="status" className="sr-only">
        Loading
      </p>
      <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}

export function SkeletonBar({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-hub-raised ${className}`} />;
}

function SkeletonMessage() {
  return (
    <div className="flex gap-2">
      <SkeletonBar className="h-9 w-9 shrink-0 rounded-md" />
      <div className="flex-1 space-y-2">
        <SkeletonBar className="h-3.5 w-40" />
        <SkeletonBar className="h-3.5 w-full" />
      </div>
    </div>
  );
}

/** A pane header over rows of messages: every route's first paint has this shape. */
export function SkeletonList({ rows }: { rows: number }) {
  return (
    <SkeletonPage>
      <div className="flex min-h-[49px] items-center border-b border-hub-line px-5">
        <SkeletonBar className="h-5 w-48" />
      </div>
      <div className="space-y-5 px-5 py-5">
        {Array.from({ length: rows }, (_, index) => (
          <SkeletonMessage key={index} />
        ))}
      </div>
    </SkeletonPage>
  );
}
