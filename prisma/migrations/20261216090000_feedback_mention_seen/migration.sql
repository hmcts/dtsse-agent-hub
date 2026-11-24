-- When the person a feedback comment names first saw it in their Mentions list, which is what the sidebar's mentions
-- count is counted from. Apart from notified_at, which is for telling them somewhere other than the Workspace.
ALTER TABLE "feedback_mention" ADD COLUMN "seen_at" TIMESTAMPTZ;

-- Mentions made before there was a list were never shown as new, and counting them now would greet everyone with a
-- badge for comments long since read.
UPDATE "feedback_mention" SET "seen_at" = now() WHERE "seen_at" IS NULL;

-- The sidebar counts a person's unseen mentions on every Assistant page.
CREATE INDEX "feedback_mention_unseen_idx" ON "feedback_mention" ("person_oid") WHERE "seen_at" IS NULL;
