import type { Metadata } from "next";
import { markFeedbackMentionsSeen } from "@/app/_actions/feedback";
import { AssistantFrame, loadFrame } from "@/app/assistant/frame";
import { MENTIONS_PATH } from "@/components/assistant/AssistantShell";
import { MentionsList } from "@/components/feedback/dev/MentionsList";
import { FeedbackHeader } from "@/components/feedback/dev/ProjectList";
import { requireViewer } from "@/viewer/current";
import { feedbackMentions } from "@/web/feedback-data";
import { requireFeedback } from "../require-feedback";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Mentions" };

/** The comments on prototypes that named the viewer with `@`, whichever projects and links they came through. */
export default async function FeedbackMentionsPage() {
  requireFeedback();
  const viewer = await requireViewer();
  const [frame, mentions] = await Promise.all([loadFrame(viewer), feedbackMentions(viewer)]);
  return (
    <AssistantFrame frame={frame} activeId={MENTIONS_PATH}>
      <div className="mx-auto flex max-w-[880px] flex-col gap-4 px-5 pb-10 pt-5">
        <FeedbackHeader title="Mentions" back={{ href: "/assistant/feedback", label: "Feedback projects" }} />
        <p className="text-[13px] text-asst-body">Comments on prototypes that name you. Open one to read it where it was left, and reply.</p>
        <MentionsList mentions={mentions} markSeen={markFeedbackMentionsSeen} />
      </div>
    </AssistantFrame>
  );
}
