CREATE TYPE "virtual_agent_desired" AS ENUM ('running', 'stopped', 'deleted');

CREATE TYPE "virtual_agent_status" AS ENUM (
  'requested', 'provisioning', 'awaiting_credentials', 'awaiting_login', 'cloning', 'running', 'stopping', 'stopped', 'failed'
);

CREATE TYPE "model_route" AS ENUM ('gateway', 'own_licence');

CREATE TYPE "virtual_agent_stop_reason" AS ENUM ('user', 'idle', 'evening', 'quota', 'expired', 'failed');

CREATE TYPE "virtual_agent_login_prompt" AS ENUM ('device_code', 'paste_code');

CREATE TYPE "virtual_agent_login_state" AS ENUM ('pending', 'completed', 'expired', 'failed');

-- A Claude Code session a person asked the hub to run for them in the preview cluster. `desired` and `generation` are
-- what the person asked for; `status` and `observed_generation` are what the orchestrator and the pod last reported.
-- The StatefulSet and PVC names follow from the id, so the orchestrator never has to be told them twice.
CREATE TABLE "virtual_agent" (
  "id"                     UUID                        PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_oid"              TEXT                        NOT NULL REFERENCES "user" ("oid"),
  "name"                   TEXT                        NOT NULL,
  "desired"                "virtual_agent_desired"     NOT NULL DEFAULT 'running',
  "status"                 "virtual_agent_status"      NOT NULL DEFAULT 'requested',
  "status_detail"          TEXT,
  "status_changed_at"      TIMESTAMPTZ(6)              NOT NULL DEFAULT now(),
  "generation"             INTEGER                     NOT NULL DEFAULT 1,
  "observed_generation"    INTEGER                     NOT NULL DEFAULT 0,
  "claimed_by"             TEXT,
  "claimed_at"             TIMESTAMPTZ(6),
  "statefulset_name"       TEXT                        GENERATED ALWAYS AS ('va-' || left("id"::text, 8)) STORED,
  "pvc_name"               TEXT                        GENERATED ALWAYS AS ('va-' || left("id"::text, 8)) STORED,
  "launch_token_hash"      BYTEA,
  "launch_token_issued_at" TIMESTAMPTZ(6),
  "agent_id"               UUID                        REFERENCES "agent" ("id") ON DELETE SET NULL,
  "model_route"            "model_route"               NOT NULL,
  "started_at"             TIMESTAMPTZ(6)              NOT NULL DEFAULT now(),
  "last_active_at"         TIMESTAMPTZ(6),
  "stopped_at"             TIMESTAMPTZ(6),
  "stop_reason"            "virtual_agent_stop_reason",
  "disk_expires_at"        TIMESTAMPTZ(6),
  "disk_deleted_at"        TIMESTAMPTZ(6),
  "created_at"             TIMESTAMPTZ(6)              NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ(6)              NOT NULL DEFAULT now(),
  CONSTRAINT "virtual_agent_owner_oid_name_key" UNIQUE ("owner_oid", "name"),
  CONSTRAINT "virtual_agent_statefulset_name_key" UNIQUE ("statefulset_name"),
  CONSTRAINT "virtual_agent_launch_token_hash_key" UNIQUE ("launch_token_hash"),
  CONSTRAINT "virtual_agent_name_length" CHECK (char_length("name") BETWEEN 1 AND 64),
  CONSTRAINT "virtual_agent_launch_token_hash_length" CHECK ("launch_token_hash" IS NULL OR octet_length("launch_token_hash") = 32)
);

CREATE INDEX "virtual_agent_owner_oid_idx" ON "virtual_agent" ("owner_oid");

-- The orchestrator's claim: the rows whose spec it has not yet applied.
CREATE INDEX "virtual_agent_pending_idx" ON "virtual_agent" ("updated_at") WHERE "generation" > "observed_generation";

-- A login the pod is waiting on the owner for: a device code to enter, or a URL whose code the owner pastes back.
-- A pasted code is AES-256-GCM sealed under a key derived from SESSION_SECRET, and removed once the pod has read it.
CREATE TABLE "virtual_agent_login" (
  "virtual_agent_id"        UUID                         NOT NULL REFERENCES "virtual_agent" ("id") ON DELETE CASCADE,
  "kind"                    "credential_kind"            NOT NULL,
  "prompt"                  "virtual_agent_login_prompt" NOT NULL,
  "user_code"               TEXT,
  "verification_uri"        TEXT                         NOT NULL,
  "expires_at"              TIMESTAMPTZ(6)               NOT NULL,
  "state"                   "virtual_agent_login_state"  NOT NULL DEFAULT 'pending',
  "pasted_code_ciphertext"  BYTEA,
  "pasted_code_iv"          BYTEA,
  "pasted_code_tag"         BYTEA,
  "pasted_code_expires_at"  TIMESTAMPTZ(6),
  "created_at"              TIMESTAMPTZ(6)               NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ(6)               NOT NULL DEFAULT now(),
  PRIMARY KEY ("virtual_agent_id", "kind"),
  CONSTRAINT "virtual_agent_login_pasted_code_whole" CHECK (
    ("pasted_code_ciphertext" IS NULL) = ("pasted_code_iv" IS NULL)
    AND ("pasted_code_iv" IS NULL) = ("pasted_code_tag" IS NULL)
    AND ("pasted_code_tag" IS NULL) = ("pasted_code_expires_at" IS NULL)
  ),
  CONSTRAINT "virtual_agent_login_device_code_has_user_code" CHECK ("prompt" <> 'device_code' OR "user_code" IS NOT NULL)
);

-- Every agent a virtual agent's sessions registered. A launch token acts only for these.
ALTER TABLE "agent" ADD COLUMN "virtual_agent_id" UUID REFERENCES "virtual_agent" ("id") ON DELETE SET NULL;

CREATE INDEX "agent_virtual_agent_id_idx" ON "agent" ("virtual_agent_id") WHERE "virtual_agent_id" IS NOT NULL;
