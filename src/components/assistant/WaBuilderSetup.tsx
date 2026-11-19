import type { Model } from "@hmcts-cft/wa-spec";
import { briefExpr, caseTypeIds, caseTypeLabel, describeColumn, permissionNames } from "@/assistant/wa-builder-text";
import { ExprView, Grid, Section, TD, TH, Words } from "@/components/assistant/WaBuilderParts";

const caseTypesText = (model: Model, only: string[] | undefined) => (only ?? caseTypeIds(model)).map((id) => caseTypeLabel(model, id)).join(", ");

/** The service's identity, its case types and what every task has by default. */
export function WaBuilderSetup({ model }: Readonly<{ model: Model }>) {
  const { service } = model;
  const configuration = model.defaults?.configuration ?? [];
  const permissions = Object.entries(model.defaults?.permissions ?? {}).flatMap(([role, grants]) => [grants].flat().map((grant) => ({ role, grant })));
  return (
    <div className="flex flex-col gap-6">
      <Section id="wa-setup-service" title="Service">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] min-[560px]:grid-cols-[max-content_1fr]">
          <dt className="text-asst-muted">Display name</dt>
          <dd>{service.displayName}</dd>
          <dt className="text-asst-muted">Jurisdiction</dt>
          <dd>{service.jurisdiction}</dd>
          <dt className="text-asst-muted">Service code</dt>
          <dd>{service.serviceCode}</dd>
          <dt className="text-asst-muted">Case types</dt>
          <dd>
            <ul className="flex flex-col gap-0.5">
              {model.caseTypes.map((caseType) => (
                <li key={caseType.id}>
                  {caseType.displayName === undefined ? null : `${caseType.displayName}, `}
                  <code className="rounded-sm bg-asst-active px-1.5 py-px font-plex-mono text-[0.9em]">{caseType.id}</code>
                </li>
              ))}
            </ul>
          </dd>
        </dl>
      </Section>
      <Section id="wa-setup-config" title="Settings every task has">
        {configuration.length === 0 ? (
          <p className="text-[13px] text-asst-muted">None.</p>
        ) : (
          <Grid label="Service-wide task settings">
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  Setting
                </th>
                <th scope="col" className={TH}>
                  Value
                </th>
                <th scope="col" className={TH}>
                  Recalculated on a case change
                </th>
                <th scope="col" className={TH}>
                  Case types
                </th>
              </tr>
            </thead>
            <tbody>
              {configuration.map((attribute, index) => (
                <tr key={`${attribute.name}-${index}`}>
                  <th scope="row" className={`${TD} font-medium`}>
                    {attribute.name}
                  </th>
                  <td className={TD}>
                    <ExprView expr={attribute.value} />
                    {attribute.when === undefined ? null : (
                      <p className="pt-1 text-xs text-asst-muted">
                        When{" "}
                        <Words
                          text={Object.entries(attribute.when)
                            .map(([column, cell]) => describeColumn(column, cell))
                            .join(" and ")}
                        />
                      </p>
                    )}
                    {attribute.note === undefined ? null : <p className="pt-1 text-xs text-asst-muted">{attribute.note}</p>}
                  </td>
                  <td className={TD}>
                    {attribute.reconfigure === undefined
                      ? "–"
                      : briefExpr(attribute.reconfigure) === "true"
                        ? "Yes"
                        : briefExpr(attribute.reconfigure) === "false"
                          ? "No"
                          : briefExpr(attribute.reconfigure)}
                  </td>
                  <td className={TD}>{caseTypesText(model, attribute.only)}</td>
                </tr>
              ))}
            </tbody>
          </Grid>
        )}
      </Section>
      <Section id="wa-setup-permissions" title="Permissions every task grants">
        {permissions.length === 0 ? (
          <p className="text-[13px] text-asst-muted">None.</p>
        ) : (
          <Grid label="Service-wide permissions">
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  Role
                </th>
                <th scope="col" className={TH}>
                  Permissions
                </th>
                <th scope="col" className={TH}>
                  Assignment priority
                </th>
                <th scope="col" className={TH}>
                  Auto-assign
                </th>
                <th scope="col" className={TH}>
                  Case types
                </th>
              </tr>
            </thead>
            <tbody>
              {permissions.map(({ role, grant }, index) => (
                <tr key={`${role}-${index}`}>
                  <th scope="row" className={`${TD} font-medium`}>
                    {role}
                  </th>
                  <td className={TD}>{permissionNames(grant.perms).join(", ")}</td>
                  <td className={TD}>{grant.priority === undefined ? "–" : briefExpr(grant.priority)}</td>
                  <td className={TD}>{grant.autoAssign === undefined ? "–" : briefExpr(grant.autoAssign) === "true" ? "Yes" : "No"}</td>
                  <td className={TD}>{caseTypesText(model, grant.only)}</td>
                </tr>
              ))}
            </tbody>
          </Grid>
        )}
      </Section>
    </div>
  );
}
