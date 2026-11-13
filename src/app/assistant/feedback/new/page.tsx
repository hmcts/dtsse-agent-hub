import { createFeedbackProject, probeFeedbackLink } from "@/app/_actions/feedback";
import { FeedbackWizard, type WizardActions } from "@/components/feedback/dev/FeedbackWizard";
import { FeedbackHeader } from "@/components/feedback/dev/ProjectList";
import { requireViewer } from "@/viewer/current";
import { FeedbackFrame, requireFeedback } from "../frame";

export const dynamic = "force-dynamic";

const ACTIONS: WizardActions = { probe: probeFeedbackLink, create: createFeedbackProject };

/** Setting up a new feedback project, which ends with the links to send to reviewers. */
export default async function NewFeedbackProjectPage() {
  requireFeedback();
  const viewer = await requireViewer();
  return (
    <FeedbackFrame viewer={viewer}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-5 pb-10 pt-5">
        <FeedbackHeader title="New feedback project" back={{ href: "/assistant/feedback", label: "Feedback projects" }} />
        <FeedbackWizard actions={ACTIONS} />
      </div>
    </FeedbackFrame>
  );
}
