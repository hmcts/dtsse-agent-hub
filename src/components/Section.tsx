/** The one section wrapper: a bounded panel with a heading row, as in dtsse-github-metrics. */
export function Section({ heading, detail, action, children }: { heading: string; detail?: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Panel>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">{heading}</h2>
        {detail ? <span className="text-xs text-slate-400">{detail}</span> : null}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children ? <div className="p-4">{children}</div> : null}
    </Panel>
  );
}

export function Panel({ children }: { children: React.ReactNode }) {
  return <section className="bg-slate-900/40 border border-slate-800 rounded-lg">{children}</section>;
}
