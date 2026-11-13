import { notFound } from "next/navigation";
import { FeedbackRefresh } from "@/components/feedback/dev/FeedbackRefresh";
import { FeedbackHeader } from "@/components/feedback/dev/ProjectList";
import { RecordingView } from "@/components/feedback/dev/RecordingView";
import { requireViewer } from "@/viewer/current";
import { feedbackRecordingPage } from "@/web/feedback-data";
import { PROJECT_ACTIONS } from "../../../actions";
import { FeedbackFrame, requireFeedback } from "../../../frame";

export const dynamic = "force-dynamic";

/** One recording of a project, played back for its team. */
export default async function FeedbackRecordingPage({ params }: Readonly<{ params: Promise<{ projectId: string; recordingId: string }> }>) {
  requireFeedback();
  const viewer = await requireViewer();
  const { projectId, recordingId } = await params;
  const data = await feedbackRecordingPage(viewer, projectId, recordingId);
  if (data === undefined) {
    notFound();
  }
  return (
    <FeedbackFrame viewer={viewer} projectId={data.project.id}>
      <FeedbackRefresh projectId={data.project.id} />
      <div className="mx-auto flex max-w-[1100px] flex-col gap-5 px-5 pb-10 pt-5">
        <FeedbackHeader
          title={`${data.recording.author.name}'s recording`}
          back={{ href: `/assistant/feedback/${data.project.id}?tab=recordings`, label: data.project.name }}
        />
        <RecordingView data={data} actions={PROJECT_ACTIONS} />
      </div>
    </FeedbackFrame>
  );
}
