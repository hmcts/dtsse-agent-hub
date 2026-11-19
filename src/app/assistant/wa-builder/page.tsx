import { listWaServices } from "@/assistant/wa-builder-store";
import { WaBuilderPage } from "@/components/assistant/WaBuilderPage";
import { WaBuilderServiceList } from "@/components/assistant/WaBuilderServiceList";
import { requireViewer } from "@/viewer/current";

export const dynamic = "force-dynamic";

/** The Work Allocation builder: the services whose task configuration is held, each at its latest version. */
export default async function WaBuilderPageRoute() {
  await requireViewer();
  const services = await listWaServices();
  return (
    <WaBuilderPage
      title="Work Allocation builder"
      intro="Read how a service's Work Allocation tasks are configured: who may act on them, when they are made, finished and cancelled, and when they are due."
      back={{ href: "/assistant", label: "Back to CFT Workspace" }}
    >
      <WaBuilderServiceList services={services} />
    </WaBuilderPage>
  );
}
