-- A conversation's slide deck: an outline the conversation's session writes in versions, the pictures it names, and
-- the .pptx the session built from each recent version. One deck per conversation. The conversation's row carries the
-- latest version's number, title and author, as it does the document's, so the frame and the sidebar read one row.
-- Retention is applied by every write, in its own transaction: see writeDeck in src/assistant/deck-store.ts.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_conversation"
  ADD COLUMN "deck_version"    INTEGER     NOT NULL DEFAULT 0 CHECK ("deck_version" >= 0),
  ADD COLUMN "deck_title"      TEXT        CHECK (char_length("deck_title") BETWEEN 1 AND 200),
  ADD COLUMN "deck_updated_by" TEXT        CHECK ("deck_updated_by" IN ('user', 'agent')),
  ADD COLUMN "deck_updated_at" TIMESTAMPTZ;

-- One version of the outline, in src/assistant/deck.ts's shape. The latest 100 are kept, and only the latest 3 keep
-- their .pptx.
CREATE TABLE "assistant_deck_version" (
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "version"         INTEGER     NOT NULL CHECK ("version" >= 1),
  "outline"         JSONB       NOT NULL CHECK (octet_length("outline"::text) <= 200000),
  "by"              TEXT        NOT NULL CHECK ("by" IN ('user', 'agent')),
  "summary"         TEXT        CHECK (char_length("summary") BETWEEN 1 AND 200),
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "pptx"            BYTEA       CHECK (octet_length("pptx") BETWEEN 1 AND 5242880),
  PRIMARY KEY ("conversation_id", "version")
);

-- A picture an outline names as `sha256:<hex>`, stored once per deck. Its type and size are what the hub read from the
-- bytes, never what the uploader said. At most 20 MiB a deck, which the write checks.
CREATE TABLE "assistant_deck_asset" (
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "sha256"          TEXT        NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "mime"            TEXT        NOT NULL CHECK ("mime" IN ('image/png', 'image/jpeg', 'image/gif')),
  "bytes"           BYTEA       NOT NULL CHECK (octet_length("bytes") BETWEEN 1 AND 5242880),
  "width"           INTEGER     NOT NULL CHECK ("width" > 0),
  "height"          INTEGER     NOT NULL CHECK ("height" > 0),
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "sha256")
);
