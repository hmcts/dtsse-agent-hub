-- Files a person attaches to an HMCTS Assistant message. The browser uploads them in parts, the conversation's pod
-- pulls them to its own disk, and the parts are deleted as soon as it says it has them. The metadata row outlives
-- them, so the thread can still show what was attached once the bytes are gone.
CREATE TABLE "assistant_upload" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "owner_oid"       TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  -- Set when the message carrying the attachment is sent, in that message's transaction. Null while the person is
  -- still composing, which is also what makes an upload claimable exactly once.
  "message_id"      BIGINT      REFERENCES "message" ("id") ON DELETE CASCADE,
  -- What the person's file was called, for the thread to show. Never used to build a path.
  "file_name"       TEXT        NOT NULL CHECK (char_length("file_name") BETWEEN 1 AND 255),
  -- What the pod writes it as. The hub decides it and this is the authoritative copy, so the pattern is a constraint
  -- rather than a convention: no separators, no leading dot, nothing a path could be escaped with.
  "stored_name"     TEXT        NOT NULL CHECK ("stored_name" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'),
  "media_type"      TEXT        NOT NULL CHECK ("media_type" ~ '^[a-z0-9][a-z0-9.+-]{0,62}/[a-z0-9][a-z0-9.+-]{0,62}$'),
  -- 25 MB, as src/assistant/uploads.ts caps it. Checked here too, because the parts are the hub's memory and disk.
  "bytes"           BIGINT      NOT NULL CHECK ("bytes" BETWEEN 1 AND 26214400),
  -- pending while parts are arriving, stored once they all have, fetched once the pod has the file, expired once the
  -- sweep gave up waiting for a pod. Only a stored upload can be attached to a message.
  "state"           TEXT        NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'stored', 'fetched', 'expired')),
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "assistant_upload_conversation_idx" ON "assistant_upload" ("conversation_id", "created_at");
CREATE INDEX "assistant_upload_message_idx" ON "assistant_upload" ("message_id") WHERE "message_id" IS NOT NULL;
-- The sweep's read: the uploads still holding bytes, oldest first.
CREATE INDEX "assistant_upload_unfetched_idx" ON "assistant_upload" ("created_at") WHERE "state" IN ('pending', 'stored');

CREATE TABLE "assistant_upload_part" (
  "upload_id" UUID    NOT NULL REFERENCES "assistant_upload" ("id") ON DELETE CASCADE,
  "index"     INTEGER NOT NULL CHECK ("index" >= 0),
  "data"      BYTEA   NOT NULL,
  PRIMARY KEY ("upload_id", "index")
);

-- PDFs, images and zips are already compressed, so TOAST compression spends CPU on both the write and every read to
-- get nothing back. EXTERNAL still moves the value out of line, which is what keeps the main table small.
ALTER TABLE "assistant_upload_part" ALTER COLUMN "data" SET STORAGE EXTERNAL;
