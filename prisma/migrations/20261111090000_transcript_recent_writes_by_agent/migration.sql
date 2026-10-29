-- agent_id joins the retention index, so that "which agents were written to since the cut-off" is an index-only scan
-- of the recent range. That is the question the per-agent trim asks before it counts anything, and the two near
-- misses for asking it are both worse:
--
--   * reading it off transcript_entry.occurred_at trusts a column the client fills in and nothing bounds, so a host
--     with its clock set back would never have the cap applied;
--   * reading it off agent.last_heartbeat_at trusts a column no upload path writes -- only registering and
--     heartbeating do -- so a client still uploading after its heartbeat loop died would be missed, as would a
--     replay against a stored agent id.
--
-- created_at is ours and is written on every insert, so it answers exactly what is being asked. Without agent_id in
-- the index the answer costs a heap page per few entries; with it, nothing but index pages over the recent range.
--
-- A second index rather than an edit to 20261110090000: that one has been applied, so its checksum is in the ledger
-- and src/store/migrate.ts would refuse the changed file. Retention is unaffected either way -- created_at still
-- leads the index.
DROP INDEX "transcript_entry_created_at_idx";

CREATE INDEX "transcript_entry_created_at_agent_id_idx" ON "transcript_entry" ("created_at", "agent_id");
