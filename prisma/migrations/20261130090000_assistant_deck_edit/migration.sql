-- The owner's edits to a deck in the web UI. Edits in quick succession amend the person's own latest version in place
-- rather than each writing a new one, so the 100 versions kept stay a history worth reading back through. Every write
-- of an outline, amend included, moves `deck_revision` on, which is how a session and a second tab see an amend that
-- leaves `deck_version` where it was. See "Revisions" in docs/agent-api.md and src/assistant/deck-edit-store.ts.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_conversation"
  ADD COLUMN "deck_revision" INTEGER NOT NULL DEFAULT 0 CHECK ("deck_revision" >= 0);

-- `editor_oid` is the person who wrote the version through the editor, and null for every other write: a session's, a
-- restore and a fork's copy, none of which an edit may amend. `updated_at` is the last amend; `created_at` stays when
-- the version was first written.
ALTER TABLE "assistant_deck_version"
  ADD COLUMN "editor_oid" TEXT,
  ADD COLUMN "updated_at" TIMESTAMPTZ;
