import { notFound } from "next/navigation";
import { getWaSpec } from "@/assistant/wa-builder-store";
import { taskName } from "@/assistant/wa-builder-text";
import { WaBuilderPage } from "@/components/assistant/WaBuilderPage";
import { requestedVersion } from "@/components/assistant/WaBuilderParts";
import { WaBuilderTaskDetail } from "@/components/assistant/WaBuilderTaskDetail";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";

export const dynamic = "force-dynamic";

/** One task, in plain language. `?version=` opens an earlier version of the spec. */
export default async function WaBuilderTaskPage({
  params,
  searchParams
}: Readonly<{ params: Promise<{ service: string; taskId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  await requireViewer();
  const [{ service, taskId }, query] = await Promise.all([params, searchParams]);
  const spec = await getWaSpec(prisma, service, requestedVersion(query));
  const task = spec?.model.tasks.find((candidate) => candidate.id === taskId);
  if (spec === null || task === undefined) {
    notFound();
  }
  return (
    <WaBuilderPage
      title={taskName(spec.model, task)}
      intro={`${spec.model.service.displayName ?? service}, version ${spec.version}. Read only.`}
      back={{ href: `/assistant/wa-builder/${encodeURIComponent(service)}?view=tasks&version=${spec.version}`, label: "Back to the task board" }}
    >
      <WaBuilderTaskDetail model={spec.model} task={task} />
    </WaBuilderPage>
  );
}
