import { PaneHeader } from "@/components/Pane";

/**
 * Every agent's page, local or virtual: a header with its name and state, the conversation in the middle and a side
 * panel. On narrow screens a local agent's panel folds into a disclosure above the conversation, rendered a second
 * time since only one copy is displayed at once; a virtual agent's holds the forms its owner uses, so it is rendered
 * once and sits below the conversation instead.
 */
export function AgentLayout({
  title,
  kind,
  subtitle,
  side,
  sideLabel,
  narrow,
  children
}: {
  title: string;
  kind: string;
  subtitle: React.ReactNode;
  side: React.ReactNode;
  sideLabel: string;
  narrow: "disclosure" | "below";
  children: React.ReactNode;
}) {
  return (
    <>
      <PaneHeader title={title} kind={kind} subtitle={subtitle} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {narrow === "disclosure" ? (
          <details className="max-h-[50vh] shrink-0 overflow-y-auto border-b border-hub-line lg:hidden">
            <summary className="cursor-pointer px-4 py-2 text-[13px] font-bold text-hub-link hover:bg-hub-raised">{sideLabel}</summary>
            {side}
          </details>
        ) : null}
        <section aria-labelledby="conversation-heading" className="flex min-h-0 min-w-0 flex-1 flex-col">
          <h2 id="conversation-heading" className="sr-only">
            Conversation
          </h2>
          {children}
        </section>
        <aside
          aria-label={sideLabel}
          className={
            narrow === "disclosure"
              ? "hidden w-80 shrink-0 overflow-y-auto border-l border-hub-line lg:block"
              : "max-h-[50vh] shrink-0 overflow-y-auto border-t border-hub-line lg:max-h-none lg:w-96 lg:border-l lg:border-t-0"
          }
        >
          {side}
        </aside>
      </div>
    </>
  );
}
