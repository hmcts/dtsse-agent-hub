-- The part of the pod's memory the kernel cannot reclaim, from `memory.stat`'s `anon` line, which is what the
-- low-memory warning is computed from.
--
-- `memory.current` and `memory.peak` both count page cache, and a container that has read the 6.8GiB workspace clone
-- holds 2.1-2.4Gi of it: cache is reclaimed at the `memory.max` watermark rather than given back, so either figure
-- sits near the limit whatever the pod is actually holding, and a threshold on one of them is crossed by file reads
-- rather than by chats. `anon` is purely additive, moves by about one conversation when a session starts or ends, and
-- is what the per-conversation constant was measured as.
--
-- Nullable like the other four and written with them: a row from a pod on a client that sent no `anon` is one the
-- warning cannot be computed for, which the Size section words as an older version rather than as an idle pod.
ALTER TABLE "virtual_agent"
  ADD COLUMN "memory_anon_bytes" BIGINT CHECK ("memory_anon_bytes" >= 0);
