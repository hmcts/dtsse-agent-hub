// What `pod-job-handlers.ts` needs to list `jira.attach-video` without loading its handler, which reaches the agent
// API's client and so the claim that list is part of.

export const VIDEO_ATTACH_KIND = "jira.attach-video";

/**
 * Under the hub's 15 minutes: the download, an Atlassian sign-in the owner may have to complete on the way (five
 * minutes), the upload and the comment.
 */
export const VIDEO_ATTACH_BUDGET_MS = 14 * 60_000;
