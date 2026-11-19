-- A job one of the Assistant's panels asks the conversation's pod to run with the owner's own credentials (`gh`,
-- `az`), which the hub does not hold. One table for every kind: a kind is a name a feature registers in
-- src/assistant/pod-job-kinds.ts, checked here by its shape rather than listed, so a new kind needs no migration.
-- See "Pod jobs" in docs/agent-api.md and src/assistant/pod-job-store.ts.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "assistant_pod_job" (
  "id"               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id"  UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "owner_oid"        TEXT        NOT NULL,
  "virtual_agent_id" UUID        NOT NULL,
  "kind"             TEXT        NOT NULL CHECK (char_length("kind") BETWEEN 1 AND 40 AND "kind" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$'),
  -- The application caps compact JSON at 8 KiB and 1 MiB; jsonb's text form spaces every separator, so the backstop
  -- here is twice that.
  "args"             JSONB       NOT NULL CHECK (octet_length("args"::text) <= 16384),
  -- Whether the kind runs one at a time per conversation, as it was when the job was asked for.
  "exclusive"        BOOLEAN     NOT NULL DEFAULT false,
  "status"           TEXT        NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'done', 'failed', 'timeout')),
  "result"           JSONB       CHECK (octet_length("result"::text) <= 2097152),
  "error"            TEXT        CHECK ("error" ~ '^[a-z][a-z0-9_]{0,39}$'),
  "detail"           TEXT        CHECK (char_length("detail") BETWEEN 1 AND 300),
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- When a pending job reads as timed out: `created_at` plus the kind's own timeout.
  "expires_at"       TIMESTAMPTZ NOT NULL,
  "finished_at"      TIMESTAMPTZ,
  CHECK ("expires_at" > "created_at"),
  CHECK (("status" = 'failed') = ("error" IS NOT NULL))
);

-- One pending job of a one-at-a-time kind per conversation: a second request joins it.
CREATE UNIQUE INDEX "assistant_pod_job_pending_key" ON "assistant_pod_job" ("conversation_id", "kind") WHERE "status" = 'pending' AND "exclusive";
-- The per-owner, per-kind rate limit.
CREATE INDEX "assistant_pod_job_owner_kind_idx" ON "assistant_pod_job" ("owner_oid", "kind", "created_at");
-- The sweep: pending jobs past their time, and jobs past their retention.
CREATE INDEX "assistant_pod_job_expires_idx" ON "assistant_pod_job" ("expires_at") WHERE "status" = 'pending';
CREATE INDEX "assistant_pod_job_created_at_idx" ON "assistant_pod_job" ("created_at");
