-- HMCTS Assistant conversations. Any virtual agent can hold them: its pod runs a Claude session per conversation, as
-- the conversation needs one, alongside its own session.
CREATE TABLE "assistant_conversation" (
  "id"                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "owner_oid"           TEXT        NOT NULL REFERENCES "user" ("oid"),
  "virtual_agent_id"    UUID        NOT NULL REFERENCES "virtual_agent" ("id") ON DELETE CASCADE,
  -- The agent of the conversation's current session. Created with the conversation, so messages can queue for it
  -- before any session runs; a /clear in the session moves it.
  "agent_id"            UUID,
  "title"               TEXT        CHECK (char_length("title") BETWEEN 1 AND 200),
  -- Checked in code against src/assistant/products.ts, so a product can be added without a migration.
  "product"             TEXT        NOT NULL DEFAULT 'other' CHECK ("product" ~ '^[a-z0-9-]{1,32}$'),
  -- Every change of product as [{product, at}], so the thread can show where it changed.
  "product_history"     JSONB       NOT NULL DEFAULT '[]' CHECK (
    jsonb_typeof("product_history") = 'array' AND jsonb_array_length("product_history") <= 50
  ),
  -- Set when a message needs a live session and none is; cleared when a session registers for the conversation.
  "wake_requested_at"   TIMESTAMPTZ,
  -- What the pod's supervisor last reported for the conversation: starting, live or queued, or null for no session.
  "session_state"       TEXT        CHECK ("session_state" IN ('starting', 'live', 'queued')),
  "session_detail"      TEXT        CHECK (char_length("session_detail") <= 200),
  "last_active_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "artefact_title"      TEXT        CHECK (char_length("artefact_title") BETWEEN 1 AND 200),
  "artefact_markdown"   TEXT        NOT NULL DEFAULT '' CHECK (char_length("artefact_markdown") <= 100000),
  "artefact_version"    INTEGER     NOT NULL DEFAULT 0 CHECK ("artefact_version" >= 0),
  "artefact_updated_by" TEXT        CHECK ("artefact_updated_by" IN ('user', 'agent')),
  "artefact_updated_at" TIMESTAMPTZ,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "assistant_conversation_owner_active_idx" ON "assistant_conversation" ("owner_oid", "last_active_at" DESC);
CREATE INDEX "assistant_conversation_wake_idx" ON "assistant_conversation" ("virtual_agent_id", "wake_requested_at")
  WHERE "wake_requested_at" IS NOT NULL;

ALTER TABLE "agent" ADD COLUMN "assistant_conversation_id" UUID REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE;
CREATE INDEX "agent_assistant_conversation_id_idx" ON "agent" ("assistant_conversation_id") WHERE "assistant_conversation_id" IS NOT NULL;

ALTER TABLE "assistant_conversation" ADD CONSTRAINT "assistant_conversation_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agent" ("id") ON DELETE SET NULL;
