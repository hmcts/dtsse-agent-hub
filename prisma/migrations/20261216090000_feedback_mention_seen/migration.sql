-- When the person a feedback comment names first saw it in their Mentions list, which is what the sidebar's mentions
-- count is counted from. Apart from notified_at, which is for telling them somewhere other than the Workspace.
ALTER TABLE "feedback_mention" ADD COLUMN "seen_at" TIMESTAMPTZ;

-- The sidebar counts a person's unseen mentions on every Assistant page.
CREATE INDEX "feedback_mention_unseen_idx" ON "feedback_mention" ("person_oid") WHERE "seen_at" IS NULL;
