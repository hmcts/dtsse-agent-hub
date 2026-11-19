-- A lookup the browser stopped waiting for, because the person typed on, is `cancelled`: it is no longer counted
-- against the lookup rate limit, it is not handed to a pod that has not started it, and a late answer for it is not
-- kept. See `cancelLookup` in src/assistant/lookup-store.ts.
ALTER TABLE "assistant_lookup"
  DROP CONSTRAINT "assistant_lookup_status_check",
  ADD CONSTRAINT "assistant_lookup_status_check" CHECK ("status" IN ('pending', 'done', 'failed', 'cancelled'));
