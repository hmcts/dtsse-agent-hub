-- The sweep looks for queued deliveries to long-offline agents, oldest first. Queued deliveries are a small, moving
-- slice of the table, so a partial index finds them without walking every delivered or expired row.
CREATE INDEX "delivery_queued_idx" ON "delivery" ("message_id") WHERE "state" = 'queued';
