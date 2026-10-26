-- An upload's bytes now outlive the pod's fetched report: they stay until the retention window closes, so the owner
-- can download their own file back from the thread. The sweep therefore reads `fetched` rows too, and its index has
-- to cover them or the read becomes a sequential scan of a table that only ever grows.
--
-- There is no matching schema.prisma change: a partial index has no Prisma representation, so none of this is in the
-- model. The column set is unchanged.
DROP INDEX "assistant_upload_unfetched_idx";

-- The sweep's read: the uploads still holding bytes, oldest first.
CREATE INDEX "assistant_upload_held_idx" ON "assistant_upload" ("created_at") WHERE "state" IN ('pending', 'stored', 'fetched');
