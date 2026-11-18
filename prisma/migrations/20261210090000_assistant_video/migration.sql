-- A conversation's journey video: one recording the session published with `agent-hub video put`. The MP4's bytes are
-- in Blob Storage, under "<conversation>/<video>.mp4", and never here; this row holds what the panel shows beside the
-- player: the captions, the chapters, the coverage and content-mismatch reports, and who the video was posted to in
-- Jira. A video is `uploading` from when the hub signs the session's write URL until the session reports the upload
-- done and the hub has found the blob at the declared size, and `ready` after. One video per conversation is ready:
-- finishing another deletes the older rows and the sweep deletes their blobs. See src/assistant/video-store.ts.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_conversation"
  ADD COLUMN "video_version"    INTEGER     NOT NULL DEFAULT 0 CHECK ("video_version" >= 0),
  ADD COLUMN "video_name"       TEXT        CHECK (char_length("video_name") BETWEEN 1 AND 200),
  ADD COLUMN "video_updated_at" TIMESTAMPTZ;

CREATE TABLE "assistant_video" (
  "video_id"            UUID        PRIMARY KEY,
  "conversation_id"     UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "status"              TEXT        NOT NULL CHECK ("status" IN ('uploading', 'ready')),
  "name"                TEXT        NOT NULL CHECK (char_length("name") BETWEEN 1 AND 200),
  "bytes"               BIGINT      NOT NULL CHECK ("bytes" BETWEEN 1 AND 209715200),
  "captions"            TEXT        CHECK (char_length("captions") <= 100000),
  "chapters"            JSONB       NOT NULL CHECK (jsonb_typeof("chapters") = 'array' AND jsonb_array_length("chapters") <= 200),
  "coverage"            TEXT        NOT NULL CHECK (char_length("coverage") <= 40000),
  "coverage_summary"    TEXT        CHECK (char_length("coverage_summary") BETWEEN 1 AND 300),
  "content_mismatches"  TEXT        NOT NULL CHECK (char_length("content_mismatches") <= 40000),
  "jira_key"            TEXT        CHECK ("jira_key" ~ '^[A-Z][A-Z0-9_]{1,9}-[0-9]{1,9}$'),
  "posted_key"          TEXT        CHECK ("posted_key" ~ '^[A-Z][A-Z0-9_]{1,9}-[0-9]{1,9}$'),
  "posted_at"           TIMESTAMPTZ,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "finished_at"         TIMESTAMPTZ,
  CHECK (("status" = 'ready') = ("finished_at" IS NOT NULL))
);

CREATE INDEX "assistant_video_conversation_idx" ON "assistant_video" ("conversation_id", "created_at");
