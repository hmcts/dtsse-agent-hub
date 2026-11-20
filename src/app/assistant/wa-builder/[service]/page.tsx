import { notFound } from "next/navigation";
import { getWaSpec } from "@/assistant/wa-builder-store";
import { WaBuilderPage } from "@/components/assistant/WaBuilderPage";
import { isWaView, Placeholder, requestedVersion, ViewTabs, type WaView } from "@/components/assistant/WaBuilderParts";
import { WaBuilderRoles } from "@/components/assistant/WaBuilderRoles";
import { WaBuilderSetup } from "@/components/assistant/WaBuilderSetup";
import { isBoardGrouping, WaBuilderTaskBoard } from "@/components/assistant/WaBuilderTaskBoard";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { fullInstant } from "@/web/format";

export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** One service's configuration, a view at a time: `?view=`, `?version=`, and the board's `?by=` and `?caseType=`. */
export default async function WaBuilderServicePage({
  params,
  searchParams
}: Readonly<{ params: Promise<{ service: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  await requireViewer();
  const [{ service }, query] = await Promise.all([params, searchParams]);
  const spec = await getWaSpec(prisma, service, requestedVersion(query));
  if (spec === null) {
    notFound();
  }
  const named = first(query.view);
  const view: WaView = isWaView(named) ? named : "setup";
  const { model } = spec;
  const by = first(query.by);
  const caseType = first(query.caseType);
  return (
    <WaBuilderPage
      title={model.service.displayName ?? service}
      intro={`Version ${spec.version}, saved by ${spec.savedBy} on ${fullInstant(spec.savedAt.toISOString())}. Read only.`}
      back={{ href: "/assistant/wa-builder", label: "Back to all services" }}
    >
      <ViewTabs service={service} current={view} version={spec.version} />
      {view === "setup" ? <WaBuilderSetup model={model} /> : null}
      {view === "roles" ? <WaBuilderRoles model={model} service={service} version={spec.version} /> : null}
      {view === "tasks" ? (
        <WaBuilderTaskBoard
          model={model}
          service={service}
          version={spec.version}
          by={isBoardGrouping(by) ? by : "roleCategory"}
          {...(caseType !== undefined && model.caseTypes.some((c) => c.id === caseType) ? { caseType } : {})}
        />
      ) : null}
      {view === "lifecycle" ? (
        <Placeholder title="Case lifecycle">
          The diagram of the case's states and events, with these tasks on it, is not built yet. It will come from the service's CCD definition.
        </Placeholder>
      ) : null}
      {view === "simulator" ? (
        <Placeholder title="Simulator">Playing a sequence of events to see which tasks are created, completed and cancelled is not built yet.</Placeholder>
      ) : null}
    </WaBuilderPage>
  );
}
