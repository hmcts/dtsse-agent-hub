-- Two indexes that only cost writes. Each is answered in full by a unique index on the same table, which every
-- query that could use one of these can use instead:
--
--   * `assistant_template_owner_idx` is `(owner_oid, name)`, the same columns in the same order as
--     `assistant_template_owner_name_key`;
--   * `virtual_agent_owner_oid_idx` is `(owner_oid)`, the leading column of `virtual_agent_owner_oid_name_key`.
DROP INDEX "assistant_template_owner_idx";
DROP INDEX "virtual_agent_owner_oid_idx";

-- `transcript_entry.message_id` is `ON DELETE SET NULL`, so every message deleted runs
--
--   UPDATE ONLY "public"."transcript_entry" SET "message_id" = NULL WHERE $1 OPERATOR(pg_catalog.=) "message_id"
--
-- and without an index on the column that is a sequential scan of the hub's largest table per message.
-- `deleteConversation` in src/assistant/store.ts deletes a pod chat's whole direct-message thread in one statement,
-- so the cost is that thread's length times the table. Partial, because most entries carry no message: the query's
-- `=` is strict, so the planner knows it implies `message_id IS NOT NULL` and uses this index.
--
-- Not CONCURRENTLY: src/store/migrate.ts wraps each migration in BEGIN/COMMIT, which rules it out. The build takes
-- a ShareLock, so uploads block for as long as it runs.
CREATE INDEX "transcript_entry_message_id_idx" ON "transcript_entry" ("message_id") WHERE "message_id" IS NOT NULL;
