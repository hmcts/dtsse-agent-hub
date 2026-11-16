-- One person's own state for a feedback project they are on the team of: when they pinned it in the Assistant's
-- sidebar, and when they last opened it, which is what its unread count is counted from. One row for both, because
-- they have the same key and are read together for every row of the sidebar.
CREATE TABLE "feedback_project_person" (
  "project_id" UUID        NOT NULL REFERENCES "feedback_project" ("id") ON DELETE CASCADE,
  "person_oid" TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "pinned_at"  TIMESTAMPTZ,
  "seen_at"    TIMESTAMPTZ,
  PRIMARY KEY ("project_id", "person_oid")
);
