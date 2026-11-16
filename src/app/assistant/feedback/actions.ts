import {
  addFeedbackLink,
  archiveFeedbackProject,
  probeFeedbackLink,
  replyToFeedbackThread,
  revokeFeedbackLink,
  rotateFeedbackLink,
  setFeedbackMembers,
  setFeedbackThreadStatus,
  updateFeedbackSettings
} from "@/app/_actions/feedback";
import type { ProjectActions } from "@/components/feedback/dev/ProjectPage";

/** The server actions a project's pages hand their components. */
export const PROJECT_ACTIONS: ProjectActions = {
  addLink: addFeedbackLink,
  revokeLink: revokeFeedbackLink,
  rotateLink: rotateFeedbackLink,
  setMembers: setFeedbackMembers,
  updateSettings: updateFeedbackSettings,
  archive: archiveFeedbackProject,
  reply: replyToFeedbackThread,
  setStatus: setFeedbackThreadStatus,
  probe: probeFeedbackLink
};
