CREATE TYPE "credential_kind" AS ENUM ('github', 'azure', 'claude');

CREATE TYPE "credential_via" AS ENUM ('web', 'cli', 'pod');

-- What the hub knows about each person's stored credentials: which they have, when and how each was last saved, and
-- the account it is for. Never the value, which is in the credentials Key Vault under `secret_name`.
CREATE TABLE "credential" (
  "owner_oid"     TEXT              NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "kind"          "credential_kind" NOT NULL,
  "secret_name"   TEXT              NOT NULL,
  "account_label" TEXT,
  "updated_at"    TIMESTAMPTZ(6)    NOT NULL DEFAULT now(),
  "updated_via"   "credential_via"  NOT NULL,
  PRIMARY KEY ("owner_oid", "kind")
);

-- The value store for development and tests, which have no credentials vault. Each value is AES-256-GCM sealed
-- under a key derived from SESSION_SECRET; the hub refuses to use this table in production.
CREATE TABLE "dev_credential_value" (
  "secret_name" TEXT           PRIMARY KEY,
  "ciphertext"  BYTEA          NOT NULL,
  "iv"          BYTEA          NOT NULL,
  "tag"         BYTEA          NOT NULL,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
