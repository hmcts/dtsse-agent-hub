-- A lookup the browser stopped waiting for, because the person typed on, is `cancelled`: a late answer for it is not
-- kept, and a pod that has not yet started it is not handed it. It still counts against the lookup rate limit, since
-- the pod was told of it as it was asked. See `cancelLookup` in src/assistant/lookup-store.ts.
ALTER TABLE "assistant_lookup"
  DROP CONSTRAINT "assistant_lookup_status_check",
  ADD CONSTRAINT "assistant_lookup_status_check" CHECK ("status" IN ('pending', 'done', 'failed', 'cancelled'));
