import { type Model, taskCases } from "@hmcts-cft/wa-spec";
import Link from "next/link";
import { type BoardGrouping, boardGroups, briefAcrossCaseTypes, briefVal, caseTypeLabel } from "@/assistant/wa-builder-text";
import { Grid, LINK, TD, TH, versionQuery } from "@/components/assistant/WaBuilderParts";

const GROUPINGS: ReadonlyArray<{ id: BoardGrouping; label: string }> = [
  { id: "roleCategory", label: "Role category" },
  { id: "workType", label: "Work type" }
];

export const isBoardGrouping = (value: string | undefined): value is BoardGrouping => GROUPINGS.some((g) => g.id === value);

const FIELD = "rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-[13px] text-asst-text";
const SUBMIT = "inline-flex items-center rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover";

/** Every task grouped by role category or work type, optionally for one case type. */
export function WaBuilderTaskBoard({
  model,
  service,
  version,
  by,
  caseType
}: Readonly<{ model: Model; service: string; version?: number; by: BoardGrouping; caseType?: string }>) {
  const groups = boardGroups(model, by, caseType);
  const base = `/assistant/wa-builder/${encodeURIComponent(service)}`;
  return (
    <div className="flex flex-col gap-5">
      <form method="get" action={base} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="view" value="tasks" />
        {version === undefined ? null : <input type="hidden" name="version" value={version} />}
        <div className="flex flex-col gap-1">
          <label htmlFor="wa-group" className="text-xs text-asst-muted">
            Group by
          </label>
          <select id="wa-group" name="by" defaultValue={by} className={FIELD}>
            {GROUPINGS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="wa-case-type" className="text-xs text-asst-muted">
            Case type
          </label>
          <select id="wa-case-type" name="caseType" defaultValue={caseType ?? ""} className={FIELD}>
            <option value="">All case types</option>
            {model.caseTypes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName ?? c.id}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={SUBMIT}>
          Show tasks
        </button>
      </form>
      {groups.length === 0 ? <p className="text-[13px] text-asst-muted">No task is configured for this case type.</p> : null}
      {groups.map(({ group, tasks }, index) => (
        <section key={group} aria-labelledby={`wa-group-${index}`} className="flex flex-col gap-2">
          <h2 id={`wa-group-${index}`} className="text-base font-semibold">
            {group} <span className="text-[13px] font-normal text-asst-muted">({tasks.length})</span>
          </h2>
          <Grid label={`Tasks: ${group}`}>
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  Task
                </th>
                <th scope="col" className={TH}>
                  {by === "workType" ? "Role category" : "Work type"}
                </th>
                <th scope="col" className={TH}>
                  Due after (days)
                </th>
                <th scope="col" className={TH}>
                  Priority (major / minor)
                </th>
                <th scope="col" className={TH}>
                  Case types
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map(({ task, name, caseTypes }) => {
                const own = taskCases(model, task);
                const cell = (resolve: (id: string) => string) => briefAcrossCaseTypes(model, { ...task, only: caseTypes }, resolve);
                return (
                  <tr key={`${task.id}-${caseTypes.join(",")}`}>
                    <th scope="row" className={`${TD} font-medium`}>
                      <Link href={`${base}/tasks/${encodeURIComponent(task.id)}${versionQuery(version, "?")}`} className={LINK}>
                        {name}
                      </Link>
                    </th>
                    <td className={TD}>{cell((id) => briefVal(model, by === "workType" ? task.roleCategory : task.workType, id, own)) || "–"}</td>
                    <td className={TD}>{cell((id) => briefVal(model, task.due?.days, id, own)) || "–"}</td>
                    <td className={TD}>
                      {cell((id) =>
                        [briefVal(model, task.priority?.major, id, own), briefVal(model, task.priority?.minor, id, own)].filter((v) => v !== "").join(" / ")
                      ) || "–"}
                    </td>
                    <td className={TD}>{caseTypes.map((id) => caseTypeLabel(model, id)).join(", ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </Grid>
        </section>
      ))}
    </div>
  );
}
