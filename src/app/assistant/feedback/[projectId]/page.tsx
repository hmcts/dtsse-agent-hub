import { notFound } from "next/navigation";
import { FeedbackRefresh } from "@/components/feedback/dev/FeedbackRefresh";
import { FeedbackHeader } from "@/components/feedback/dev/ProjectList";
import { ProjectPage, projectTab } from "@/components/feedback/dev/ProjectPage";
import { requireViewer } from "@/viewer/current";
import { feedbackProjectPage } from "@/web/feedback-data";
import { PROJECT_ACTIONS } from "../actions";
import { FeedbackFrame, requireFeedback } from "../frame";

export const dynamic = "force-dynamic";

/** One feedback project, for its owner and team; `?tab=` picks the section. Anyone else's is not found. */
export default async function FeedbackProjectPage({
  params,
  searchParams
}: Readonly<{ params: Promise<{ projectId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  requireFeedback();
  const viewer = await requireViewer();
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const data = await feedbackProjectPage(viewer, projectId);
  if (data === undefined) {
    notFound();
  }
  const tab = projectTab(query.tab, data.project.access === "owner");
  return (
    <FeedbackFrame viewer={viewer}>
      <FeedbackRefresh projectId={data.project.id} />
      <div className="mx-auto flex max-w-[1280px] flex-col gap-5 px-5 pb-10 pt-5">
        <FeedbackHeader title={data.project.name} back={{ href: "/assistant/feedback", label: "Feedback projects" }} />
        <ProjectPage data={data} tab={tab} actions={PROJECT_ACTIONS} />
      </div>
    </FeedbackFrame>
  );
}
