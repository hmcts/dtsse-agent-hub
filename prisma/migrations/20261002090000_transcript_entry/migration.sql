CREATE TYPE "transcript_role" AS ENUM ('user', 'assistant', 'tool_use', 'tool_result', 'system');

-- A Claude Code session's conversation as its client uploads it. `entry_key` is the client's own id for an entry, so
-- a batch sent twice stores each entry once.
CREATE TABLE "transcript_entry" (
  "id"          BIGSERIAL         PRIMARY KEY,
  "agent_id"    UUID              NOT NULL REFERENCES "agent" ("id") ON DELETE CASCADE,
  "session_id"  TEXT              NOT NULL,
  "entry_key"   TEXT              NOT NULL,
  "role"        "transcript_role" NOT NULL,
  "content"     JSONB             NOT NULL,
  "truncated"   BOOLEAN           NOT NULL DEFAULT false,
  "redacted"    BOOLEAN           NOT NULL DEFAULT false,
  "message_id"  BIGINT            REFERENCES "message" ("id") ON DELETE SET NULL,
  "occurred_at" TIMESTAMPTZ(6)    NOT NULL,
  "created_at"  TIMESTAMPTZ(6)    NOT NULL DEFAULT now(),
  CONSTRAINT "transcript_entry_agent_id_entry_key_key" UNIQUE ("agent_id", "entry_key"),
  -- The API refuses content over 16 KiB as the client serialised it. jsonb's text form adds a space after every `:`
  -- and `,`, so this backstop sits at twice that rather than at the API's limit.
  CONSTRAINT "transcript_entry_content_size" CHECK (octet_length("content"::text) <= 32768)
);

-- The conversation view: an agent's entries in time order, paged backwards from the newest.
CREATE INDEX "transcript_entry_agent_id_occurred_at_id_idx" ON "transcript_entry" ("agent_id", "occurred_at", "id");

-- The retention sweep: every agent's entries older than the cut-off, without walking each agent's range.
CREATE INDEX "transcript_entry_occurred_at_idx" ON "transcript_entry" ("occurred_at");
