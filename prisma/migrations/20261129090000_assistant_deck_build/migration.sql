-- A .pptx built on the owner's request from a deck version that keeps none: the latest 3 versions keep their own, and
-- every older one is built by the conversation's pod when asked for. The built bytes are kept with the build, for
-- 24 hours, rather than with the version, so the "latest 3 keep a .pptx" rule stays what bounds the versions' bytes.
-- See "Deck builds" in docs/agent-api.md and src/assistant/deck-build-store.ts.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "assistant_deck_build" (
  "id"              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "version"         INTEGER     NOT NULL CHECK ("version" >= 1),
  "status"          TEXT        NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'done', 'failed', 'timeout')),
  "error"           TEXT        CHECK (char_length("error") BETWEEN 1 AND 2000),
  "pptx"            BYTEA       CHECK (octet_length("pptx") BETWEEN 1 AND 5242880),
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finished_at"     TIMESTAMPTZ,
  CHECK (("status" = 'done') = ("pptx" IS NOT NULL))
);

-- One build of a version at a time: a second request joins the one running.
CREATE UNIQUE INDEX "assistant_deck_build_pending_key" ON "assistant_deck_build" ("conversation_id", "version") WHERE "status" = 'pending';
CREATE INDEX "assistant_deck_build_conversation_idx" ON "assistant_deck_build" ("conversation_id", "version", "created_at" DESC);
CREATE INDEX "assistant_deck_build_created_at_idx" ON "assistant_deck_build" ("created_at");
