-- The pod's own account of its container's memory, read off its cgroup, which the hub has no other way to learn:
-- every call between the two is pod to hub. Nullable throughout and written together, because "the pod has not said"
-- is a state the UI shows differently from "the pod is idle" -- a zero would read as the second.
--
-- No column for a request: only the limit is in the cgroup, and the request is the orchestrator's own constant.
ALTER TABLE "virtual_agent"
  ADD COLUMN "memory_limit_bytes"   BIGINT CHECK ("memory_limit_bytes" >= 0),
  ADD COLUMN "memory_current_bytes" BIGINT CHECK ("memory_current_bytes" >= 0),
  -- The high-water mark since the pod booted, which is what the warning is computed from: the live figure dips
  -- between turns, so a pod at its ceiling reads as comfortable whenever nobody is mid-answer.
  ADD COLUMN "memory_peak_bytes"    BIGINT CHECK ("memory_peak_bytes" >= 0),
  ADD COLUMN "memory_reported_at"   TIMESTAMPTZ(6);
