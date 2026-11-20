import { type Model, ownEntry } from "@hmcts-cft/wa-spec";
import Link from "next/link";
import { briefExpr, grantConditions, permissionColumns, permissionNames, rolesByCategory, taskName, tasksUsingProfile } from "@/assistant/wa-builder-text";
import { Grid, LINK, PermissionTick, Section, TD, TH, versionQuery, Words, YesNo } from "@/components/assistant/WaBuilderParts";

/** Each role's category, then each permission profile as a grid of roles against the permissions they hold. */
export function WaBuilderRoles({ model, service, version }: Readonly<{ model: Model; service: string; version?: number }>) {
  const profiles = Object.entries(model.permissionProfiles ?? {});
  return (
    <div className="flex flex-col gap-6">
      <Section id="wa-roles" title="Roles">
        <div className="flex flex-col gap-3">
          {rolesByCategory(model).map(({ category, roles }) => (
            <div key={category} className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">{category}</h3>
              <ul className="flex flex-wrap gap-1.5">
                {roles.map((role) => (
                  <li key={role} className="rounded-full border border-asst-line px-2.5 py-0.5 font-plex-mono text-xs">
                    {role}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>
      <Section id="wa-profiles" title="Permission profiles">
        {profiles.length === 0 ? <p className="text-[13px] text-asst-muted">None.</p> : null}
        {profiles.map(([name, grants]) => {
          const rows = Object.entries(grants).map(([role, grant]) => ({
            role,
            grant,
            perms: permissionNames(grant.perms),
            conditions: grantConditions(grant, ownEntry(model.roles, role)?.category)
          }));
          const columns = permissionColumns(rows);
          const tasks = tasksUsingProfile(model, name);
          return (
            <div key={name} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{name}</h3>
              <Grid label={`Permissions of the ${name} profile`}>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>
                      Role
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
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ role, grant, perms, conditions }) => (
                    <tr key={role}>
                      <th scope="row" className={`${TD} font-medium`}>
                        {role}
                      </th>
                      {columns.map((column) => (
                        <td key={column} className={`${TD} text-center`}>
                          <PermissionTick has={perms.includes(column)} />
                        </td>
                      ))}
                      <td className={TD}>{grant.priority === undefined ? "–" : briefExpr(grant.priority)}</td>
                      <td className={TD}>{grant.autoAssign === undefined ? "–" : <YesNo value={briefExpr(grant.autoAssign)} />}</td>
                      <td className={TD}>{conditions.length === 0 ? "–" : <Words text={conditions.join("; ")} />}</td>
                    </tr>
                  ))}
                </tbody>
              </Grid>
              <p className="text-[13px] text-asst-body">
                {tasks.length === 0 ? (
                  "No task uses this profile."
                ) : (
                  <>
                    Used by{" "}
                    {tasks.map((task, index) => (
                      <span key={task.id}>
                        {index > 0 ? ", " : ""}
                        <Link
                          href={`/assistant/wa-builder/${encodeURIComponent(service)}/tasks/${encodeURIComponent(task.id)}${versionQuery(version, "?")}`}
                          className={LINK}
                        >
                          {taskName(model, task)}
                        </Link>
                      </span>
                    ))}
                  </>
                )}
              </p>
            </div>
          );
        })}
      </Section>
    </div>
  );
}
