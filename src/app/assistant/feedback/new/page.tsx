import type { Metadata } from "next";
import { createFeedbackProject, probeFeedbackLink } from "@/app/_actions/feedback";
import { AssistantFrame, loadFrame } from "@/app/assistant/frame";
import { FeedbackWizard, type WizardActions } from "@/components/feedback/dev/FeedbackWizard";
import { FeedbackHeader } from "@/components/feedback/dev/ProjectList";
import { allowPrivateTargets } from "@/feedback/targets";
import { requireViewer } from "@/viewer/current";
import { requireFeedback } from "../require-feedback";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New feedback project" };

const ACTIONS: WizardActions = { probe: probeFeedbackLink, create: createFeedbackProject };

/** Setting up a new feedback project, which ends with the links to send to reviewers. */
export default async function NewFeedbackProjectPage() {
  requireFeedback();
  const frame = await loadFrame(await requireViewer());
  return (
    <AssistantFrame frame={frame}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 px-5 pb-10 pt-5">
        <FeedbackHeader title="New feedback project" back={{ href: "/assistant/feedback", label: "Feedback projects" }} />
        <FeedbackWizard actions={ACTIONS} allowHttp={allowPrivateTargets()} />
      </div>
    </AssistantFrame>
  );
}
