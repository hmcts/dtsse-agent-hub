-- A theme the team gives feedback threads, so comments about one thing can be read, and refined, together. Free text,
-- one per thread; null is none.
ALTER TABLE "feedback_thread" ADD COLUMN "theme" TEXT;

-- A conversation a team member started to refine some of a project's threads into a Jira story: which threads went
-- into it, and the keys of the Jira issues exported from it, which the threads then show. Deleting the conversation
-- leaves the record, without it, so the threads still show the issues it produced; so does deleting the person who
-- started it.
CREATE TABLE "feedback_refinement" (
  "id"              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id"      UUID        NOT NULL REFERENCES "feedback_project" ("id") ON DELETE CASCADE,
  "conversation_id" UUID        UNIQUE REFERENCES "assistant_conversation" ("id") ON DELETE SET NULL,
  "owner_oid"       TEXT        REFERENCES "user" ("oid") ON DELETE SET NULL,
  "jira_keys"       TEXT[]      NOT NULL DEFAULT '{}',
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "feedback_refinement_project_idx" ON "feedback_refinement" ("project_id");
CREATE INDEX "feedback_refinement_owner_idx" ON "feedback_refinement" ("owner_oid");

CREATE TABLE "feedback_refinement_thread" (
  "refinement_id" UUID NOT NULL REFERENCES "feedback_refinement" ("id") ON DELETE CASCADE,
  "thread_id"     UUID NOT NULL REFERENCES "feedback_thread" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("refinement_id", "thread_id")
);
CREATE INDEX "feedback_refinement_thread_thread_idx" ON "feedback_refinement_thread" ("thread_id");
