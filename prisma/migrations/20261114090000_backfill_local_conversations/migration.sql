-- Gives every laptop session that already has a transcript a conversation, so the sessions people ran before
-- conversations existed are readable rather than invisible.
--
-- Registration creates one, and a heartbeat now creates one for a session that was already running when this
-- shipped. Neither reaches a session that has already ended: it will not register again and it will never heartbeat
-- again, so its agent row keeps `assistant_conversation_id` null for good while its transcript sits there with
-- nothing pointing at it. This is the one-off that closes that.
--
-- Scoped to agents that have a transcript entry, for two reasons. An agent with none has nothing to show — a chat
-- with no words in it — and `local-sweep.ts` would collect it a day later anyway, so creating one would be a row
-- written to be deleted. And transcript entries are kept 30 days, which bounds the work to the sessions whose words
-- still exist rather than to every session ever registered.
--
-- `title` follows `localTitle`: the agent's name, trimmed, its whitespace collapsed, cut to 200 characters, and null
-- when that leaves nothing. `last_active_at` is the agent's own last heartbeat rather than `now()`, so the sidebar
-- orders these by when the session was last alive instead of stacking them all at the moment of this deploy.
--
-- `agent_id` is set to the agent, which is what `conversationView` reads to find the session's transcript. Not
-- announced: there is no connection to tell, and the next page load reads the rows.
WITH eligible AS (
  SELECT a.id, a.owner_oid, a.name, a.last_heartbeat_at
    FROM agent a
   WHERE a.virtual_agent_id IS NULL
     AND a.assistant_conversation_id IS NULL
     AND EXISTS (SELECT 1 FROM transcript_entry t WHERE t.agent_id = a.id)
), made AS (
  INSERT INTO assistant_conversation (owner_oid, virtual_agent_id, agent_id, product, title, created_at, updated_at, last_active_at)
  SELECT e.owner_oid,
         NULL,
         e.id,
         'general',
         NULLIF(LEFT(regexp_replace(btrim(e.name), '\s+', ' ', 'g'), 200), ''),
         e.last_heartbeat_at,
         e.last_heartbeat_at,
         e.last_heartbeat_at
    FROM eligible e
  RETURNING id, agent_id
)
UPDATE agent a
   SET assistant_conversation_id = m.id
  FROM made m
 WHERE a.id = m.agent_id;
