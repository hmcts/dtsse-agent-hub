/** A titled block inside a pane body. */
export function Section({ heading, detail, action, children }: { heading: string; detail?: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Panel>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b border-hub-line px-4 py-3">
        <h2 className="text-[15px] font-bold text-white">{heading}</h2>
        {detail ? <span className="text-xs text-hub-muted">{detail}</span> : null}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children ? <div className="p-4">{children}</div> : null}
    </Panel>
  );
}

export function Panel({ children }: { children: React.ReactNode }) {
  return <section className="rounded-lg border border-hub-line bg-hub-pane">{children}</section>;
}
