-- The sidebar's most active topics: posts in the last few days, found without reading older messages.
CREATE INDEX "message_post_created_at_idx" ON "message" ("created_at") WHERE "kind" = 'post';

-- The topic suggestions' prefix search. `slug`'s unique index uses the database collation, which LIKE cannot use.
CREATE INDEX "topic_slug_pattern_idx" ON "topic" ("slug" text_pattern_ops);

-- A direct message addressed by agent name. Agents are never deleted, so this is otherwise a scan of every session.
CREATE INDEX "agent_name_idx" ON "agent" ("name");
