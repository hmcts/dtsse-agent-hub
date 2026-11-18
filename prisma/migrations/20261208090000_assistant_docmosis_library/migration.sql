-- A person's index of a Docmosis template library: the .docx files in one folder of a GitHub repository, as their
-- own pod read it with their own gh sign-in, so the browser can search it without asking the pod per keystroke. One
-- row per person and library. The row is also the library's one check in flight: `refresh_id` is the check last sent
-- to the pod, and only an answer naming it is kept. See src/assistant/docmosis-library-store.ts.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "assistant_docmosis_library" (
  "owner_oid"            TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  -- `owner/repo@ref:path`, DOCMOSIS_LIBRARY_ID in src/assistant/docmosis-library.ts.
  "library_id"           TEXT        NOT NULL CHECK (char_length("library_id") BETWEEN 1 AND 300),
  -- The commit the entries were read at; null until the first index arrives.
  "commit_sha"           TEXT        CHECK ("commit_sha" ~ '^[0-9a-f]{40}$'),
  -- The commit check's ETag, sent back as If-None-Match so an unchanged library costs no rate limit.
  "etag"                 TEXT        CHECK (char_length("etag") BETWEEN 1 AND 200),
  -- [[path, blob_sha, size], ...], in path order.
  "entries"              JSONB       NOT NULL DEFAULT '[]'
                                     CHECK (jsonb_typeof("entries") = 'array' AND octet_length("entries"::text) <= 1048576),
  "entry_count"          INTEGER     NOT NULL DEFAULT 0 CHECK ("entry_count" BETWEEN 0 AND 10000),
  -- When the pod last answered a check, whatever it answered.
  "checked_at"           TIMESTAMPTZ,
  "refresh_id"           UUID,
  "refresh_requested_at" TIMESTAMPTZ,
  -- Whether the check last asked for was forced, which is what spaces forced checks 30 seconds apart.
  "refresh_forced"       BOOLEAN     NOT NULL DEFAULT false,
  -- Why the last check failed; null when it succeeded. The entries of the last good index are kept either way.
  "error"                TEXT        CHECK ("error" IN ('signed_out', 'sso', 'not_found', 'rate_limited', 'failed')),
  "detail"               TEXT        CHECK (char_length("detail") BETWEEN 1 AND 300),
  "sso_url"              TEXT        CHECK ("sso_url" LIKE 'https://github.com/%' AND char_length("sso_url") <= 500),
  "reset_at"             TIMESTAMPTZ,
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_oid", "library_id"),
  CONSTRAINT "assistant_docmosis_library_refresh" CHECK ("refresh_id" IS NULL OR "refresh_requested_at" IS NOT NULL),
  CONSTRAINT "assistant_docmosis_library_failure" CHECK ("error" IS NOT NULL OR ("detail" IS NULL AND "sso_url" IS NULL AND "reset_at" IS NULL)),
  CONSTRAINT "assistant_docmosis_library_entries" CHECK ("commit_sha" IS NOT NULL OR "entry_count" = 0)
);

-- The pod's answer names only the check, so it is found by that.
CREATE UNIQUE INDEX "assistant_docmosis_library_refresh_id" ON "assistant_docmosis_library" ("refresh_id") WHERE "refresh_id" IS NOT NULL;
