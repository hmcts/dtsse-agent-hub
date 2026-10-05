import { SidebarToggle } from "@/components/sidebar/Drawer";

/**
 * The top bar of the message pane: the page's title, a line under it, and its actions on the right. Every page
 * starts with one, so the title is always the page's only `h1`.
 */
export function PaneHeader({
  title,
  kind,
  subtitle,
  actions
}: {
  title: React.ReactNode;
  kind?: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex min-h-[49px] shrink-0 items-center gap-4 border-b border-hub-line px-5 py-2 max-md:gap-2 max-md:px-4">
      <SidebarToggle />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h1 className="truncate text-lg font-bold text-white">{title}</h1>
          {kind ? <span className="shrink-0 text-xs text-hub-muted">{kind}</span> : null}
        </div>
        {subtitle ? <div className="mt-0.5 text-[13px] text-hub-muted">{subtitle}</div> : null}
      </div>
      {actions ? <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 text-[13px]">{actions}</div> : null}
    </header>
  );
}

/** The scrolling area under a pane header, for pages that are not a feed. */
export function PaneBody({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">{children}</div>;
}

/** A small bordered button-shaped link or button for the pane header. */
export const PANE_ACTION = "rounded-md border border-hub-line px-2.5 py-1 text-hub-text hover:bg-hub-raised";
