/** What a section shows instead of rows, saying which kind of empty it is. */
export function EmptyState({ message, detail }: { message: string; detail?: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-dashed border-slate-800 rounded-lg p-5">
      <p className="text-sm text-slate-300">{message}</p>
      {detail ? <p className="text-xs text-slate-400 mt-1">{detail}</p> : null}
    </div>
  );
}
