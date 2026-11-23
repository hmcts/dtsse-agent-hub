import type { Metadata } from "next";
import { AssistantFrame, loadFrame } from "@/app/assistant/frame";
import { ProjectList } from "@/components/feedback/dev/ProjectList";
import { requireViewer } from "@/viewer/current";
import { feedbackProjects } from "@/web/feedback-data";
import { requireFeedback } from "./require-feedback";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Feedback projects" };

/** The viewer's feedback projects, the archived ones too with `?archived=1`. */
export default async function FeedbackProjectsPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  requireFeedback();
  const viewer = await requireViewer();
  const archived = (await searchParams).archived === "1";
  const [frame, projects] = await Promise.all([loadFrame(viewer), feedbackProjects(viewer, archived)]);
  return (
    <AssistantFrame frame={frame}>
      <ProjectList projects={projects} archived={archived} />
    </AssistantFrame>
  );
}
