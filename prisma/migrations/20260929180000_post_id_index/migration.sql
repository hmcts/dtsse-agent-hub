-- Every post before a cursor, newest first, for Home's feed. Walking the primary key would read every direct as well.
CREATE INDEX "message_post_id_idx" ON "message" ("id") WHERE "kind" = 'post';
