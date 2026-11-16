-- Prototype feedback: a project a person sets up for one or more prototypes, the share links reviewers open it
-- through, the comment threads reviewers pin to a page's elements, and the voice-and-replay recordings they make. The
-- bytes of a recording and of a page snapshot are in Blob Storage under the project's id; these rows say where. See
-- src/feedback/.
CREATE TABLE "feedback_project" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "owner_oid"      TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "name"           TEXT        NOT NULL CHECK (char_length("name") BETWEEN 1 AND 120),
  -- Whether a recording masks every input's value, not just passwords, which are always masked.
  "mask_inputs"    BOOLEAN     NOT NULL DEFAULT false,
  -- How long a thread or a recording is kept, which the sweep applies.
  "retention_days" INTEGER     NOT NULL DEFAULT 90 CHECK ("retention_days" BETWEEN 1 AND 365),
  -- An archived project's links stop working at once; the sweep deletes it, blobs and all, a week later.
  "archived_at"    TIMESTAMPTZ,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "feedback_project_owner_idx" ON "feedback_project" ("owner_oid", "created_at");
CREATE INDEX "feedback_project_archived_idx" ON "feedback_project" ("archived_at") WHERE "archived_at" IS NOT NULL;

-- The project's team besides its owner: they see every comment and recording, reply and resolve. Shaped like
-- `assistant_conversation_share`, and like it a person has to have used the hub to be named.
CREATE TABLE "feedback_member" (
  "project_id"   UUID        NOT NULL REFERENCES "feedback_project" ("id") ON DELETE CASCADE,
  "member_oid"   TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  -- Always the project's owner, who alone changes the team.
  "added_by_oid" TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("project_id", "member_oid")
);

CREATE INDEX "feedback_member_member_idx" ON "feedback_member" ("member_oid", "created_at");

-- One prototype address a project collects feedback on, and the token its share link carries. Holding a live token
-- and being signed in is what makes someone a reviewer, so the token is long random bytes, never derived from the row.
CREATE TABLE "feedback_link" (
  "id"                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "project_id"        UUID        NOT NULL REFERENCES "feedback_project" ("id") ON DELETE CASCADE,
  "label"             TEXT        NOT NULL CHECK (char_length("label") BETWEEN 1 AND 80),
  -- http as well as https, for a prototype on a developer's own machine: which scheme a deployment accepts is
  -- `checkTargetUrl`'s to say, and it refuses http under NODE_ENV=production.
  "target_url"        TEXT        NOT NULL CHECK (char_length("target_url") <= 2048 AND "target_url" ~ '^https?://'),
  -- The target's origin, the only one the proxy fetches for this link.
  "origin"            TEXT        NOT NULL CHECK ("origin" ~ '^https?://[^/?#@\s]+$'),
  "token"             TEXT        NOT NULL UNIQUE CHECK ("token" ~ '^[A-Za-z0-9_-]{22,86}$'),
  "prototype_version" TEXT        CHECK (char_length("prototype_version") BETWEEN 1 AND 100),
  "revoked_at"        TIMESTAMPTZ,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "feedback_link_project_idx" ON "feedback_link" ("project_id", "created_at");

-- One reviewer's recording through one link: an audio track and rrweb replay chunks, each uploaded as numbered
-- segments, and a status that is `ready` once the reviewer stopped it.
CREATE TABLE "feedback_recording" (
  "id"                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "project_id"        UUID        NOT NULL REFERENCES "feedback_project" ("id") ON DELETE CASCADE,
  "link_id"           UUID        NOT NULL REFERENCES "feedback_link" ("id") ON DELETE CASCADE,
  "author_oid"        TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "started_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "ended_at"          TIMESTAMPTZ,
  "duration_ms"       INTEGER     CHECK ("duration_ms" >= 0),
  "status"            TEXT        NOT NULL DEFAULT 'recording' CHECK ("status" IN ('recording', 'ready', 'failed')),
  "prototype_version" TEXT        CHECK (char_length("prototype_version") BETWEEN 1 AND 100)
);

-- The rate limit counts a reviewer's recent recordings on a link; the sweep reads by age.
CREATE INDEX "feedback_recording_link_idx" ON "feedback_recording" ("link_id", "author_oid", "started_at");
CREATE INDEX "feedback_recording_project_idx" ON "feedback_recording" ("project_id", "started_at");
CREATE INDEX "feedback_recording_author_idx" ON "feedback_recording" ("author_oid");

-- A comment thread pinned to one element of one page of a prototype. `anchor` is what the widget found the element
-- by (selector, text, tag, rect, viewport), checked by src/feedback/schemas.ts before it is stored. A thread whose
-- element can no longer be found is `detached` until someone re-anchors it.
CREATE TABLE "feedback_thread" (
  "id"                UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "project_id"        UUID        NOT NULL REFERENCES "feedback_project" ("id") ON DELETE CASCADE,
  "link_id"           UUID        NOT NULL REFERENCES "feedback_link" ("id") ON DELETE CASCADE,
  "author_oid"        TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "page_path"         TEXT        NOT NULL CHECK (char_length("page_path") BETWEEN 1 AND 2048 AND "page_path" LIKE '/%'),
  "anchor"            JSONB       NOT NULL,
  -- Where the page's rrweb snapshot is in the container, when one was taken.
  "snapshot_blob"     TEXT        CHECK (char_length("snapshot_blob") BETWEEN 1 AND 500),
  "status"            TEXT        NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'resolved', 'detached')),
  "resolved_by_oid"   TEXT        REFERENCES "user" ("oid") ON DELETE SET NULL,
  "resolved_at"       TIMESTAMPTZ,
  -- The recording running when the thread was made, and how far into it.
  "recording_id"      UUID        REFERENCES "feedback_recording" ("id") ON DELETE SET NULL,
  "offset_ms"         INTEGER     CHECK ("offset_ms" >= 0),
  "prototype_version" TEXT        CHECK (char_length("prototype_version") BETWEEN 1 AND 100),
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Moved on by every reply, status change and re-anchor, and what retention is measured from.
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (("status" = 'resolved') = ("resolved_at" IS NOT NULL))
);

CREATE INDEX "feedback_thread_link_idx" ON "feedback_thread" ("link_id", "page_path", "created_at");
CREATE INDEX "feedback_thread_project_idx" ON "feedback_thread" ("project_id", "updated_at");
CREATE INDEX "feedback_thread_author_idx" ON "feedback_thread" ("author_oid", "created_at");
CREATE INDEX "feedback_thread_recording_idx" ON "feedback_thread" ("recording_id") WHERE "recording_id" IS NOT NULL;

-- The thread's first comment is made with it; every later one is a reply.
CREATE TABLE "feedback_comment" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "thread_id"  UUID        NOT NULL REFERENCES "feedback_thread" ("id") ON DELETE CASCADE,
  "author_oid" TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "body"       TEXT        NOT NULL CHECK (char_length("body") BETWEEN 1 AND 10000),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "feedback_comment_thread_idx" ON "feedback_comment" ("thread_id", "created_at");
CREATE INDEX "feedback_comment_author_idx" ON "feedback_comment" ("author_oid", "created_at");

-- A person a comment names with `@`. The hub's pages read the rows; `notified_at` is for a notification sent elsewhere.
CREATE TABLE "feedback_mention" (
  "comment_id"  UUID        NOT NULL REFERENCES "feedback_comment" ("id") ON DELETE CASCADE,
  "person_oid"  TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "notified_at" TIMESTAMPTZ,
  PRIMARY KEY ("comment_id", "person_oid")
);

CREATE INDEX "feedback_mention_person_idx" ON "feedback_mention" ("person_oid");

-- One uploaded piece of a recording. The row is written when the upload is asked for, so it names where the blob
-- will be whether or not the browser finished putting it there; the player skips one that is missing.
CREATE TABLE "feedback_recording_segment" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "recording_id" UUID        NOT NULL REFERENCES "feedback_recording" ("id") ON DELETE CASCADE,
  "kind"         TEXT        NOT NULL CHECK ("kind" IN ('audio', 'replay')),
  "seq"          INTEGER     NOT NULL CHECK ("seq" BETWEEN 0 AND 9999),
  "page_path"    TEXT        CHECK (char_length("page_path") BETWEEN 1 AND 2048 AND "page_path" LIKE '/%'),
  "blob_path"    TEXT        NOT NULL CHECK (char_length("blob_path") BETWEEN 1 AND 500),
  "offset_ms"    INTEGER     NOT NULL CHECK ("offset_ms" >= 0),
  "bytes"        INTEGER     NOT NULL CHECK ("bytes" BETWEEN 1 AND 26214400),
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("recording_id", "kind", "seq")
);
