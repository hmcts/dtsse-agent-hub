import { type Expr, type Model, type Task, taskCases, type Val } from "@hmcts-cft/wa-spec";
import {
  cancelCategories,
  caseTypeLabel,
  DUE_LABELS,
  describeCompletion,
  describeLink,
  describeTaskRule,
  describeTrigger,
  groupByCaseType,
  PRIORITY_LABELS,
  permissionColumns,
  reconfiguredAttributes,
  reconfigureRules,
  resolveCompletions,
  resolvePermissions,
  resolveTriggers,
  resolveVal,
  rulesForTask
} from "@/assistant/wa-builder-text";
import { CODE, ExprView, Grid, PerCaseType, PermissionTick, Section, TD, TH, Words, YesNo } from "@/components/assistant/WaBuilderParts";

const SOURCE: Record<string, string> = { profile: "Profile", changed: "Profile, changed for this task", added: "Added for this task", default: "Every task" };

function Sentences({ items, empty }: Readonly<{ items: string[]; empty: string }>) {
  return items.length === 0 ? (
    <p className="text-[13px] text-asst-muted">{empty}</p>
  ) : (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px]">
      {items.map((item, index) => (
        <li key={`${index}-${item}`}>
          <Words text={item} />
        </li>
      ))}
    </ul>
  );
}

/** One attribute's value, shown once or once for each group of case types that differ. */
function ValueCell({ model, task, val }: Readonly<{ model: Model; task: Task; val: Val | undefined }>) {
  const cases = taskCases(model, task);
  return (
    <PerCaseType model={model} groups={groupByCaseType(cases, (id) => resolveVal(model, val, id, cases))}>
      {(values: Expr[]) =>
        values.length === 0 ? (
          <span className="text-asst-muted">Not set</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {values.map((value, index) => (
              <li key={`${index}-${JSON.stringify(value)}`}>
                <ExprView expr={value} />
              </li>
            ))}
          </ul>
        )
      }
    </PerCaseType>
  );
}

/** Rows of label and value, each value shown once or once for each group of case types that differ. */
function ValueList({ model, task, rows }: Readonly<{ model: Model; task: Task; rows: Array<[string, Val | undefined]> }>) {
  const present = rows.filter(([, val]) => val !== undefined);
  if (present.length === 0) {
    return <p className="text-[13px] text-asst-muted">Nothing set.</p>;
  }
  return (
    <dl className="flex flex-col gap-3 text-[13px]">
      {present.map(([label, val]) => (
        <div key={label} className="flex flex-col gap-1">
          <dt className="text-asst-muted">{label}</dt>
          <dd>
            <ValueCell model={model} task={task} val={val} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One task in plain language: when it is made, finished, cancelled and recalculated, what it is worth and who may act on it. */
export function WaBuilderTaskDetail({ model, task }: Readonly<{ model: Model; task: Task }>) {
  const cases = taskCases(model, task);
  const link = task.link;
  const due = Object.entries(task.due ?? {}).map(([key, val]): [string, Val | undefined] => [DUE_LABELS[key] ?? key, val]);
  const priority = Object.entries(task.priority ?? {}).map(([key, val]): [string, Val | undefined] => [PRIORITY_LABELS[key] ?? key, val]);
  const extra: Array<[string, Val | undefined]> = [
    ["Title", task.title],
    ...(link === undefined ? [["Description", task.description] as [string, Val | undefined]] : []),
    ...Object.entries(task.additionalProperties ?? {}).map(([key, val]): [string, Val | undefined] => [`Additional property ${key}`, val]),
    ...Object.entries(task.attributes ?? {}).map(([key, val]): [string, Val | undefined] => [key, val])
  ];
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] min-[560px]:grid-cols-[max-content_1fr]">
        <dt className="text-asst-muted">Task id</dt>
        <dd>
          <code className={CODE}>{task.id}</code>
        </dd>
        <dt className="text-asst-muted">Name</dt>
        <dd>
          <ValueCell model={model} task={task} val={task.name} />
        </dd>
        {task.initialName === undefined ? null : (
          <>
            <dt className="text-asst-muted">Name when created</dt>
            <dd>
              <ValueCell model={model} task={task} val={task.initialName} />
            </dd>
          </>
        )}
        <dt className="text-asst-muted">Case types</dt>
        <dd>{cases.map((id) => caseTypeLabel(model, id)).join(", ")}</dd>
        <dt className="text-asst-muted">Work type</dt>
        <dd>
          <ValueCell model={model} task={task} val={task.workType} />
        </dd>
        <dt className="text-asst-muted">Role category</dt>
        <dd>
          <ValueCell model={model} task={task} val={task.roleCategory} />
        </dd>
      </dl>

      <Section id="wa-created" title="When it is created">
        <PerCaseType model={model} groups={groupByCaseType(cases, (id) => resolveTriggers(model, task, id).map(describeTrigger))}>
          {(items: string[]) => <Sentences items={items} empty="No event creates this task." />}
        </PerCaseType>
      </Section>

      <Section id="wa-completed" title="When it is completed">
        <PerCaseType model={model} groups={groupByCaseType(cases, (id) => resolveCompletions(model, task, id).map(describeCompletion))}>
          {(items: string[]) => <Sentences items={items} empty="No event completes this task." />}
        </PerCaseType>
      </Section>

      <Section id="wa-cancelled" title="When it is cancelled">
        <PerCaseType
          model={model}
          groups={groupByCaseType(cases, (id) => {
            const { named, calculated } = cancelCategories(model, task, id);
            return { items: rulesForTask(model, task, id).map(describeTaskRule), named: named.length > 0, calculated };
          })}
        >
          {(found: { items: string[]; named: boolean; calculated: boolean }) => (
            <>
              {found.calculated ? (
                <p className="text-[13px] text-asst-muted">Its category is worked out for each case, so a rule that names a category may or may not apply.</p>
              ) : null}
              <Sentences
                items={found.items}
                empty={found.named || found.calculated ? "No rule cancels it." : "It has no cancel category, so only a rule for every task cancels it."}
              />
            </>
          )}
        </PerCaseType>
      </Section>

      <Section id="wa-reconfigured" title="When the case changes">
        <PerCaseType model={model} groups={groupByCaseType(cases, (id) => reconfiguredAttributes(model, task, id))}>
          {(names: string[]) =>
            names.length === 0 ? (
              <p className="text-[13px] text-asst-muted">Nothing is recalculated.</p>
            ) : (
              <p className="text-[13px]">
                These are recalculated: <Words text={names.map((name) => `\`${name}\``).join(", ")} />.
              </p>
            )
          }
        </PerCaseType>
        <PerCaseType model={model} groups={groupByCaseType(cases, (id) => reconfigureRules(model, task, id).map(describeTaskRule))}>
          {(items: string[]) => <Sentences items={items} empty="No event reconfigures tasks." />}
        </PerCaseType>
      </Section>

      <Section id="wa-due" title="Due date">
        <ValueList model={model} task={task} rows={due} />
      </Section>

      <Section id="wa-priority" title="Priority">
        <ValueList model={model} task={task} rows={priority} />
      </Section>

      <Section id="wa-permissions" title="Who can do what">
        <PerCaseType model={model} groups={groupByCaseType(cases, (id) => resolvePermissions(model, task, id))}>
          {(rows) => {
            const columns = permissionColumns(rows);
            return rows.length === 0 ? (
              <p className="text-[13px] text-asst-muted">No role has permissions on this task.</p>
            ) : (
              <Grid label="Task permissions">
                <thead>
                  <tr>
                    <th scope="col" className={TH}>
                      Role
                    </th>
                    <th scope="col" className={TH}>
                      Category
                    </th>
                    {columns.map((column) => (
                      <th key={column} scope="col" className={TH}>
                        {column}
                      </th>
                    ))}
                    <th scope="col" className={TH}>
                      Assignment priority
                    </th>
                    <th scope="col" className={TH}>
                      Auto-assign
                    </th>
                    <th scope="col" className={TH}>
                      Applies when
                    </th>
                    <th scope="col" className={TH}>
                      From
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${index}-${row.role}-${row.source}-${row.profile ?? ""}`}>
                      <th scope="row" className={`${TD} font-medium`}>
                        {row.role}
                      </th>
                      <td className={TD}>{row.category}</td>
                      {columns.map((column) => (
                        <td key={column} className={`${TD} text-center`}>
                          <PermissionTick has={row.perms.includes(column)} />
                        </td>
                      ))}
                      <td className={TD}>{row.priority}</td>
                      <td className={TD}>
                        <YesNo value={row.autoAssign} />
                      </td>
                      <td className={TD}>{row.conditions.length === 0 ? "–" : <Words text={row.conditions.join("; ")} />}</td>
                      <td className={TD}>
                        {SOURCE[row.source]}
                        {row.profile === undefined ? "" : `: ${row.profile}`}
                        {row.replaces === undefined ? "" : `, replacing the grant of profile ${row.replaces}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Grid>
            );
          }}
        </PerCaseType>
      </Section>

      <Section id="wa-content" title="What the person sees">
        {link === undefined ? null : (
          <p className="text-[13px]">
            <span className="text-asst-muted">Link: </span>
            <Words text={describeLink(link)} />
          </p>
        )}
        <ValueList model={model} task={task} rows={extra} />
      </Section>
    </div>
  );
}
