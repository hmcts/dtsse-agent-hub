-- A conversation's slide decks, Docmosis templates and GOV.UK Notify templates, any number of each. Each is an item of
-- its own table, holding what the conversation's row held of the one it had: the latest version's number, revision,
-- title or name, author and time (and, for a Docmosis template, whether its PDF is rendered). The versions, and a
-- deck's built .pptx files, are keyed on the item. A conversation's primary item of a kind is its oldest, which is what
-- `/api/agent/{id}/deck`, `/docmosis` and `/notify` and an older client read. See src/assistant/deck-store.ts,
-- docmosis-store.ts and notify-store.ts.
--
-- Pictures (`assistant_deck_asset`) and .docx files (`assistant_docmosis_asset`) stay keyed on the conversation: a
-- session uploads them before the version that names them, which for a new item is before the item exists, and what
-- is named is content-addressed, so two items of a conversation can share one.
--
-- Every conversation with a deck or a template gets one item of that kind carrying it, with its versions and builds.
--
-- The conversation's `deck_*`, `docmosis_*` and `notify_*` columns stay, unread, for the previous build serving
-- beside this one, whose client names them; prisma/schema.prisma marks them `@ignore`, and a later migration drops
-- them.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "assistant_deck" (
  "id"              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "version"         INTEGER     NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "revision"        INTEGER     NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "title"           TEXT        CHECK (char_length("title") BETWEEN 1 AND 200),
  "updated_by"      TEXT        CHECK ("updated_by" IN ('user', 'agent')),
  "updated_at"      TIMESTAMPTZ,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "assistant_docmosis" (
  "id"              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "version"         INTEGER     NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "revision"        INTEGER     NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "name"            TEXT        CHECK (char_length("name") BETWEEN 1 AND 200),
  "updated_by"      TEXT        CHECK ("updated_by" IN ('user', 'agent')),
  "updated_at"      TIMESTAMPTZ,
  "pdf_state"       TEXT        NOT NULL DEFAULT 'pending' CHECK ("pdf_state" IN ('pending', 'ready', 'failed')),
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "assistant_notify" (
  "id"              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "version"         INTEGER     NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "revision"        INTEGER     NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "name"            TEXT        CHECK (char_length("name") BETWEEN 1 AND 500),
  "updated_by"      TEXT        CHECK ("updated_by" IN ('user', 'agent')),
  "updated_at"      TIMESTAMPTZ,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The list, oldest first, which is also how the primary item is found.
CREATE INDEX "assistant_deck_conversation_idx" ON "assistant_deck" ("conversation_id", "created_at");
CREATE INDEX "assistant_docmosis_conversation_idx" ON "assistant_docmosis" ("conversation_id", "created_at");
CREATE INDEX "assistant_notify_conversation_idx" ON "assistant_notify" ("conversation_id", "created_at");

INSERT INTO "assistant_deck" ("conversation_id", "version", "revision", "title", "updated_by", "updated_at", "created_at")
SELECT c."id", c."deck_version", c."deck_revision", c."deck_title", c."deck_updated_by", c."deck_updated_at", c."created_at"
  FROM "assistant_conversation" c
 WHERE c."deck_version" > 0 OR EXISTS (SELECT 1 FROM "assistant_deck_version" v WHERE v."conversation_id" = c."id");

INSERT INTO "assistant_docmosis" ("conversation_id", "version", "revision", "name", "updated_by", "updated_at", "pdf_state", "created_at")
SELECT c."id", c."docmosis_version", c."docmosis_revision", c."docmosis_name", c."docmosis_updated_by", c."docmosis_updated_at", c."docmosis_pdf_state", c."created_at"
  FROM "assistant_conversation" c
 WHERE c."docmosis_version" > 0 OR EXISTS (SELECT 1 FROM "assistant_docmosis_version" v WHERE v."conversation_id" = c."id");

INSERT INTO "assistant_notify" ("conversation_id", "version", "revision", "name", "updated_by", "updated_at", "created_at")
SELECT c."id", c."notify_version", c."notify_revision", c."notify_name", c."notify_updated_by", c."notify_updated_at", c."created_at"
  FROM "assistant_conversation" c
 WHERE c."notify_version" > 0 OR EXISTS (SELECT 1 FROM "assistant_notify_version" v WHERE v."conversation_id" = c."id");

-- Each version table is keyed on its item. `conversation_id` stays on the rows, which is what the pictures' retention
-- and a deck build's join read.
ALTER TABLE "assistant_deck_version" ADD COLUMN "item_id" UUID REFERENCES "assistant_deck" ("id") ON DELETE CASCADE;
UPDATE "assistant_deck_version" v SET "item_id" = d."id" FROM "assistant_deck" d WHERE d."conversation_id" = v."conversation_id";
ALTER TABLE "assistant_deck_version" ALTER COLUMN "item_id" SET NOT NULL;
ALTER TABLE "assistant_deck_version" DROP CONSTRAINT "assistant_deck_version_pkey";
ALTER TABLE "assistant_deck_version" ADD PRIMARY KEY ("item_id", "version");

ALTER TABLE "assistant_docmosis_version" ADD COLUMN "item_id" UUID REFERENCES "assistant_docmosis" ("id") ON DELETE CASCADE;
UPDATE "assistant_docmosis_version" v SET "item_id" = d."id" FROM "assistant_docmosis" d WHERE d."conversation_id" = v."conversation_id";
ALTER TABLE "assistant_docmosis_version" ALTER COLUMN "item_id" SET NOT NULL;
ALTER TABLE "assistant_docmosis_version" DROP CONSTRAINT "assistant_docmosis_version_pkey";
ALTER TABLE "assistant_docmosis_version" ADD PRIMARY KEY ("item_id", "version");

ALTER TABLE "assistant_notify_version" ADD COLUMN "item_id" UUID REFERENCES "assistant_notify" ("id") ON DELETE CASCADE;
UPDATE "assistant_notify_version" v SET "item_id" = d."id" FROM "assistant_notify" d WHERE d."conversation_id" = v."conversation_id";
ALTER TABLE "assistant_notify_version" ALTER COLUMN "item_id" SET NOT NULL;
ALTER TABLE "assistant_notify_version" DROP CONSTRAINT "assistant_notify_version_pkey";
ALTER TABLE "assistant_notify_version" ADD PRIMARY KEY ("item_id", "version");

-- A build is of one item's version. One at a time still: a second request joins the one running.
ALTER TABLE "assistant_deck_build" ADD COLUMN "item_id" UUID REFERENCES "assistant_deck" ("id") ON DELETE CASCADE;
UPDATE "assistant_deck_build" b SET "item_id" = d."id" FROM "assistant_deck" d WHERE d."conversation_id" = b."conversation_id";
-- A build is held for 24 hours, so one with no deck to belong to is not worth keeping.
DELETE FROM "assistant_deck_build" WHERE "item_id" IS NULL;
ALTER TABLE "assistant_deck_build" ALTER COLUMN "item_id" SET NOT NULL;
DROP INDEX "assistant_deck_build_pending_key";
DROP INDEX "assistant_deck_build_conversation_idx";
CREATE UNIQUE INDEX "assistant_deck_build_pending_key" ON "assistant_deck_build" ("item_id", "version") WHERE "status" = 'pending';
CREATE INDEX "assistant_deck_build_item_idx" ON "assistant_deck_build" ("item_id", "version", "created_at" DESC);
