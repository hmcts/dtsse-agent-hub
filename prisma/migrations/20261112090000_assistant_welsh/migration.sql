-- A Welsh translation job for the HMCTS Assistant's Welsh page: one run of cft-workspace's scripts/welsh in the
-- person's pod, with their own GitHub and twg sign-ins, so the hub holds neither. The hub records the job, the pod's
-- supervisor runs it and answers, and the page reads the answer back. No job generates Welsh. Each new job deletes its
-- assistant's jobs over 7 days old, and their files with them.
CREATE TABLE "assistant_welsh_job" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "virtual_agent_id" UUID        NOT NULL REFERENCES "virtual_agent" ("id") ON DELETE CASCADE,
  "kind"             TEXT        NOT NULL CHECK ("kind" IN ('info', 'search', 'scan', 'import_check', 'import', 'apply_preview', 'apply',
                                                            'story_candidates', 'story_preview', 'story_write')),
  "product"          TEXT        NOT NULL CHECK ("product" ~ '^[a-z][a-z0-9-]{0,39}$'),
  -- The kind's arguments, checked by src/assistant/welsh.ts before they are stored.
  "args"             JSONB       NOT NULL,
  "status"           TEXT        NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'done', 'failed')),
  -- What scripts/welsh printed, at most 512 KiB, which the page reads only the known fields of.
  "result"           JSONB,
  "error"            TEXT        CHECK ("error" IN ('signed_out', 'failed')),
  "detail"           TEXT        CHECK (char_length("detail") <= 500),
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "answered_at"      TIMESTAMPTZ
);

-- How jobs are counted for the rate limit and swept: an assistant's own, by age.
CREATE INDEX "assistant_welsh_job_agent_idx" ON "assistant_welsh_job" ("virtual_agent_id", "created_at");

-- A spreadsheet: one the person uploaded for a job to read (a Welsh Language Unit return), or one a job made for them
-- to download (a request for the WLU, or the queries on a return). Only its owner downloads it.
CREATE TABLE "assistant_welsh_file" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "virtual_agent_id" UUID        NOT NULL REFERENCES "virtual_agent" ("id") ON DELETE CASCADE,
  "owner_oid"        TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  -- Set for a file a job made; null for one the person uploaded.
  "job_id"           UUID        REFERENCES "assistant_welsh_job" ("id") ON DELETE CASCADE,
  "name"             TEXT        NOT NULL CHECK (char_length("name") BETWEEN 1 AND 200),
  "bytes"            BYTEA       NOT NULL CHECK (octet_length("bytes") BETWEEN 1 AND 5242880),
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "assistant_welsh_file_agent_idx" ON "assistant_welsh_file" ("virtual_agent_id", "created_at");
CREATE INDEX "assistant_welsh_file_job_idx" ON "assistant_welsh_file" ("job_id");
