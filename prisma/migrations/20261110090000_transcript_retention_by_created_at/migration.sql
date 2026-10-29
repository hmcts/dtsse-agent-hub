-- Retention now deletes on created_at, which this hub sets, rather than occurred_at, which is whatever the client
-- read off its own transcript line. There is no upper bound on occurred_at anywhere -- the upload schema checks only
-- that it parses -- so an entry stamped in the future satisfied neither deletion rule: retention tests
-- occurred_at < now() - 30 days and never reached it, and the per-agent trim ranks by occurred_at DESC, so it sorted
-- as the newest thing the agent had and was preferentially kept. Nothing else deletes a transcript entry, and agent
-- rows are never deleted, so those entries stayed for good.
--
-- That was survivable only while the trim was unconditional and held every agent to 20,000 whatever its timestamps
-- said. Now that the trim applies to agents still being heard from, retention has to be the backstop it is
-- documented as, and it cannot be one while a client chooses the column it keys on.
--
-- Swapped rather than added: occurred_at is never filtered or ordered without agent_id anywhere else -- the
-- conversation page and the trim's ranking both use transcript_entry_agent_id_occurred_at_id_idx -- so this index
-- had the retention sweep as its only reader. The write path carries the same number of indexes as before.
DROP INDEX "transcript_entry_occurred_at_idx";

CREATE INDEX "transcript_entry_created_at_idx" ON "transcript_entry" ("created_at");
