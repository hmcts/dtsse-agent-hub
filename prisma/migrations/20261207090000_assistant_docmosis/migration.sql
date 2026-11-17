-- A conversation's Docmosis template: the .docx the session edits, the form schema extracted from it, the data the
-- form holds, and the PDF rendered from them, written in versions. One template per conversation. The conversation's
-- row carries the latest version's number, revision, name and author, as it does the deck's, so the frame and the
-- sidebar read one row. Retention is applied by every write, in its own transaction: see
-- src/assistant/docmosis-store.ts.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_conversation"
  ADD COLUMN "docmosis_version"    INTEGER     NOT NULL DEFAULT 0 CHECK ("docmosis_version" >= 0),
  ADD COLUMN "docmosis_revision"   INTEGER     NOT NULL DEFAULT 0 CHECK ("docmosis_revision" >= 0),
  ADD COLUMN "docmosis_name"       TEXT        CHECK (char_length("docmosis_name") BETWEEN 1 AND 200),
  ADD COLUMN "docmosis_updated_by" TEXT        CHECK ("docmosis_updated_by" IN ('user', 'agent')),
  ADD COLUMN "docmosis_updated_at" TIMESTAMPTZ,
  ADD COLUMN "docmosis_pdf_state"  TEXT        NOT NULL DEFAULT 'pending' CHECK ("docmosis_pdf_state" IN ('pending', 'ready', 'failed'));

-- One version. The latest 50 are kept, and only the latest 10 keep their PDF. `revision` counts the person's amends of
-- the data of this version; `editor_oid` is the person who wrote it through the web UI, which is what lets their next
-- save amend it, and null for every other write.
CREATE TABLE "assistant_docmosis_version" (
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "version"         INTEGER     NOT NULL CHECK ("version" >= 1),
  "revision"        INTEGER     NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "name"            TEXT        NOT NULL CHECK (char_length("name") BETWEEN 1 AND 200),
  "docx_sha256"     TEXT        NOT NULL CHECK ("docx_sha256" ~ '^[0-9a-f]{64}$'),
  "schema"          JSONB       NOT NULL CHECK (octet_length("schema"::text) <= 120000),
  "data"            JSONB       NOT NULL CHECK (octet_length("data"::text) <= 120000),
  "by"              TEXT        NOT NULL CHECK ("by" IN ('user', 'agent')),
  "editor_oid"      TEXT,
  "summary"         TEXT        CHECK (char_length("summary") BETWEEN 1 AND 200),
  "pdf"             BYTEA       CHECK (octet_length("pdf") BETWEEN 1 AND 5242880),
  "render_error"    JSONB       CHECK (octet_length("render_error"::text) <= 100000),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "version")
);

-- A .docx a version names by its SHA-256, stored once per conversation. At most 64 MiB a conversation, which the write
-- checks.
CREATE TABLE "assistant_docmosis_asset" (
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "sha256"          TEXT        NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "bytes"           BYTEA       NOT NULL CHECK (octet_length("bytes") BETWEEN 1 AND 5242880),
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "sha256")
);
