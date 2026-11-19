-- What a person's template library index needs beyond its first table: when a forced check was last asked for, which
-- spaces forced checks 30 seconds apart however many checks were asked for between them; the virtual agent the check
-- in flight was sent to, the only one whose answer is kept; how many templates the pod found and left out; and a key
-- of the owner's own in the address the browser caches the entries under. See src/assistant/docmosis-library-store.ts.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_docmosis_library"
  DROP COLUMN "refresh_forced",
  ADD COLUMN "forced_at"        TIMESTAMPTZ,
  ADD COLUMN "refresh_agent_id" UUID,
  ADD COLUMN "dropped"          INTEGER     NOT NULL DEFAULT 0 CHECK ("dropped" >= 0),
  ADD COLUMN "entries_key"      UUID        NOT NULL DEFAULT gen_random_uuid(),
  ADD CONSTRAINT "assistant_docmosis_library_dropped" CHECK ("commit_sha" IS NOT NULL OR "dropped" = 0);
