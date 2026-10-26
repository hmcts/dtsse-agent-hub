-- The pod's own account of what its persistent volume holds, which the hub has no other way to learn: every call
-- between the two is pod to hub. Nullable throughout, because "the pod has not said" is a state the UI has to show
-- differently from "the pod holds nothing" -- a zero would read as "you have no files".
ALTER TABLE "virtual_agent"
  ADD COLUMN "uploads_bytes"       BIGINT CHECK ("uploads_bytes" >= 0),
  ADD COLUMN "volume_used_bytes"   BIGINT CHECK ("volume_used_bytes" >= 0),
  ADD COLUMN "volume_total_bytes"  BIGINT CHECK ("volume_total_bytes" >= 0),
  -- The largest files it holds, as [{upload_id, bytes}], at most 200 and in the order the pod sent them.
  ADD COLUMN "uploads_files"       JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "uploads_reported_at" TIMESTAMPTZ(6);

-- When the owner asked for the pod's copy of a file to go, and when a report of the pod's confirmed it had. A request
-- outstanding is what the sessions stream replays, so it survives a pod restart; the row itself is never deleted,
-- because the thread goes on saying a file was attached.
ALTER TABLE "assistant_upload"
  ADD COLUMN "pod_delete_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "pod_deleted_at"          TIMESTAMPTZ(6);

-- Read on every sessions-stream connect, grouped by conversation, and otherwise never: partial so it stays the size
-- of the outstanding requests rather than of every upload ever made.
CREATE INDEX "assistant_upload_pod_delete_idx" ON "assistant_upload" ("conversation_id", "created_at")
  WHERE "pod_delete_requested_at" IS NOT NULL AND "pod_deleted_at" IS NULL;
