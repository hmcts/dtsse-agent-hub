import { FeedbackRefresh } from "@/components/feedback/dev/FeedbackRefresh";
import { ProjectList } from "@/components/feedback/dev/ProjectList";
import { requireViewer } from "@/viewer/current";
import { feedbackProjects } from "@/web/feedback-data";
import { FeedbackFrame, requireFeedback } from "./frame";

export const dynamic = "force-dynamic";

/** The viewer's feedback projects, the archived ones too with `?archived=1`. */
export default async function FeedbackProjectsPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  requireFeedback();
  const viewer = await requireViewer();
  const archived = (await searchParams).archived === "1";
  const projects = await feedbackProjects(viewer, archived);
  return (
    <FeedbackFrame viewer={viewer}>
      <FeedbackRefresh />
      <ProjectList projects={projects} archived={archived} />
    </FeedbackFrame>
  );
}
