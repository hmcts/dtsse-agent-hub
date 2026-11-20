import Link from "next/link";
import { Grid, LINK, TD, TH } from "@/components/assistant/WaBuilderParts";
import { fullInstant, instant } from "@/web/format";

export interface WaServiceRow {
  service: string;
  displayName: string;
  latestVersion: number;
  updatedAt: Date;
}

/** Every service whose Work Allocation configuration is held: its latest version and when that was saved. */
export function WaBuilderServiceList({ services }: Readonly<{ services: readonly WaServiceRow[] }>) {
  if (services.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-asst-line px-4 py-3.5 text-[13px] text-asst-muted">
        No service has its Work Allocation configuration here yet.
      </p>
    );
  }
  return (
    <Grid label="Services">
      <thead>
        <tr>
          <th scope="col" className={TH}>
            Service
          </th>
          <th scope="col" className={TH}>
            Latest version
          </th>
          <th scope="col" className={TH}>
            Updated
          </th>
        </tr>
      </thead>
      <tbody>
        {services.map((row) => (
          <tr key={row.service}>
            <th scope="row" className={`${TD} font-medium`}>
              <Link href={`/assistant/wa-builder/${encodeURIComponent(row.service)}`} className={LINK}>
                {row.displayName}
              </Link>
            </th>
            <td className={TD}>{row.latestVersion}</td>
            <td className={TD}>
              <time dateTime={row.updatedAt.toISOString()} title={fullInstant(row.updatedAt.toISOString())}>
                {instant(row.updatedAt.toISOString())}
              </time>
            </td>
          </tr>
        ))}
      </tbody>
    </Grid>
  );
}
