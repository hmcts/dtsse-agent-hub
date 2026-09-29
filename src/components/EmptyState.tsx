/** What a list shows instead of rows, saying which kind of empty it is. */
export function EmptyState({ message, detail }: { message: string; detail?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-hub-line px-5 py-6 text-center">
      <p className="text-[15px] text-hub-text">{message}</p>
      {detail ? <p className="text-[13px] text-hub-muted mt-1">{detail}</p> : null}
    </div>
  );
}
