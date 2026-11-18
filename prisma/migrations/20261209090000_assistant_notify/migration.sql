-- A conversation's GOV.UK Notify template: a draft of one template's subject and body, the personalisation the person
-- previews it with, and the Notify version it was taken from, written in versions. One template per conversation. The
-- conversation's row carries the latest version's number, revision, name and author, as it does the Docmosis
-- template's, so the frame and the page read one row. Retention is applied by every write, in its own transaction:
-- see src/assistant/notify-store.ts. The hub holds no Notify API key: the template is read from Notify by the person's
-- own pod.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_conversation"
  ADD COLUMN "notify_version"    INTEGER     NOT NULL DEFAULT 0 CHECK ("notify_version" >= 0),
  ADD COLUMN "notify_revision"   INTEGER     NOT NULL DEFAULT 0 CHECK ("notify_revision" >= 0),
  ADD COLUMN "notify_name"       TEXT        CHECK (char_length("notify_name") BETWEEN 1 AND 500),
  ADD COLUMN "notify_updated_by" TEXT        CHECK ("notify_updated_by" IN ('user', 'agent')),
  ADD COLUMN "notify_updated_at" TIMESTAMPTZ;

-- One version. The latest 50 are kept. `revision` counts the person's amends of this version; `editor_oid` is the
-- person who wrote it through the web UI, which is what lets their next save amend it, and null for every other write.
-- `notify_version`, `notify_subject` and `notify_body` are the template as Notify held it when it was read, which the
-- draft is compared with, and `notify_preview` Notify's own preview of that version with no personalisation: HTML for
-- an email, text otherwise.
CREATE TABLE "assistant_notify_version" (
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "version"         INTEGER     NOT NULL CHECK ("version" >= 1),
  "revision"        INTEGER     NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "product"         TEXT        NOT NULL CHECK ("product" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$'),
  "template_id"     UUID        NOT NULL,
  "service_id"      UUID        NOT NULL,
  "type"            TEXT        NOT NULL CHECK ("type" IN ('email', 'sms', 'letter')),
  "name"            TEXT        NOT NULL CHECK (char_length("name") BETWEEN 1 AND 500),
  "subject"         TEXT        CHECK (char_length("subject") <= 1000),
  "body"            TEXT        NOT NULL CHECK (char_length("body") <= 40000),
  "notify_version"  INTEGER     NOT NULL CHECK ("notify_version" >= 1),
  "notify_subject"  TEXT        CHECK (char_length("notify_subject") <= 1000),
  "notify_body"     TEXT        NOT NULL CHECK (char_length("notify_body") <= 40000),
  "notify_preview"  TEXT        CHECK (octet_length("notify_preview") <= 120000),
  "data"            JSONB       NOT NULL CHECK (octet_length("data"::text) <= 40000),
  "by"              TEXT        NOT NULL CHECK ("by" IN ('user', 'agent')),
  "editor_oid"      TEXT,
  "summary"         TEXT        CHECK (char_length("summary") BETWEEN 1 AND 200),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "version"),
  -- A text message has no subject; an email and a letter always have one, which may be empty while it is drafted.
  CHECK (("type" = 'sms') = ("subject" IS NULL)),
  CHECK (("type" = 'sms') = ("notify_subject" IS NULL))
);
