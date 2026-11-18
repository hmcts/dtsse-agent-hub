// What `pod-job-handlers.ts` needs to list `docmosis.load` without loading its handler, which reaches the agent API's
// client and so the claim that list is part of.

export const DOCMOSIS_LOAD_KIND = "docmosis.load";

/** Under the hub's two minutes, leaving room for the frame's delivery and the answer. */
export const LOAD_BUDGET_MS = 100_000;
