-- Every stopped agent's disk now has an expiry, set when it is stopped. Those stopped before that have none, which the
-- disk sweep never matches, so their disks were kept for good. They get a full period from this migration rather than
-- from when they stopped, so their owners see the warning before anything is deleted. An agent being deleted loses its
-- StatefulSet and disk together, so it needs none.
UPDATE virtual_agent
   SET disk_expires_at = now() + interval '14 days'
 WHERE desired = 'stopped' AND disk_expires_at IS NULL AND disk_deleted_at IS NULL;
