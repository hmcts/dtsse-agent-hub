-- migrate: no transaction
-- `transcript_entry.message_id` is `ON DELETE SET NULL`, so every message deleted runs
--
--   UPDATE ONLY "public"."transcript_entry" SET "message_id" = NULL WHERE $1 OPERATOR(pg_catalog.=) "message_id"
--
-- and without an index on the column that is a sequential scan of the hub's largest table per message.
-- `deleteConversation` in src/assistant/store.ts deletes a pod chat's whole direct-message thread in one statement,
-- so the cost is that thread's length times the table. Partial, because most entries carry no message: the query's
-- `=` is strict, so the planner knows it implies `message_id IS NOT NULL` and uses this index.
--
-- CONCURRENTLY, so the build serving while this runs keeps uploading transcripts, which is why this migration runs
-- outside a transaction (see src/store/migrate.ts). A concurrent build that fails leaves an INVALID index behind,
-- which `IF NOT EXISTS` would take as done, so the index is dropped first: this file only reruns when it did not
-- finish, and then whatever it left is rebuilt from nothing.
DROP INDEX CONCURRENTLY IF EXISTS "transcript_entry_message_id_idx";
CREATE INDEX CONCURRENTLY "transcript_entry_message_id_idx" ON "transcript_entry" ("message_id") WHERE "message_id" IS NOT NULL;
