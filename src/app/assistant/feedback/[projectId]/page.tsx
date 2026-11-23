import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { markFeedbackProjectSeen } from "@/app/_actions/feedback";
import { AssistantFrame } from "@/app/assistant/frame";
import { projectTab } from "@/components/feedback/dev/look";
import { MarkSeen } from "@/components/feedback/dev/MarkSeen";
import { FeedbackHeader } from "@/components/feedback/dev/ProjectList";
import { ProjectPage } from "@/components/feedback/dev/ProjectPage";
import { allowPrivateTargets } from "@/feedback/targets";
import { requireViewer } from "@/viewer/current";
import { feedbackProjectName, feedbackProjectPage } from "@/web/feedback-data";
import { PROJECT_ACTIONS } from "../actions";
import { requireFeedback } from "../require-feedback";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Readonly<{ params: Promise<{ projectId: string }> }>): Promise<Metadata> {
  requireFeedback();
  const name = await feedbackProjectName(await requireViewer(), (await params).projectId);
  return { title: name?.trim() || "Feedback project" };
}

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
    <AssistantFrame viewer={viewer} activeId={data.project.id}>
      <MarkSeen projectId={data.project.id} markSeen={markFeedbackProjectSeen} />
      <div className="mx-auto flex max-w-[1280px] flex-col gap-5 px-5 pb-10 pt-5">
        <FeedbackHeader title={data.project.name} back={{ href: "/assistant/feedback", label: "Feedback projects" }} />
        <ProjectPage data={data} tab={tab} actions={PROJECT_ACTIONS} allowHttp={allowPrivateTargets()} />
      </div>
    </AssistantFrame>
  );
}
