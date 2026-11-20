-- A person's Bulk Scan form specs, built on the Assistant's Bulk Scan page. A spec is one form's field list (the
-- `FormSpec` of packages/bulk-scan-spec) held as JSON, and every save is a new version of it, so what was signed off is
-- never edited afterwards. Owner only: nothing here is shared. See src/bulk-scan/spec-store.ts.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "bulk_scan_spec" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "owner_oid"  TEXT        NOT NULL REFERENCES "user" ("oid"),
  "name"       TEXT        NOT NULL CHECK (char_length("name") BETWEEN 1 AND 200),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "bulk_scan_spec_owner_idx" ON "bulk_scan_spec" ("owner_oid", "created_at");

CREATE TABLE "bulk_scan_spec_version" (
  "spec_id"            UUID        NOT NULL REFERENCES "bulk_scan_spec" ("id") ON DELETE CASCADE,
  "version"            INTEGER     NOT NULL CHECK ("version" >= 1),
  "spec"               JSONB       NOT NULL,
  "saved_by_oid"       TEXT        NOT NULL REFERENCES "user" ("oid"),
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "signed_off_by_oid"  TEXT        REFERENCES "user" ("oid"),
  "signed_off_at"      TIMESTAMPTZ,
  PRIMARY KEY ("spec_id", "version"),
  -- Who signed a version off and when are one fact: a version has both or neither.
  CONSTRAINT "bulk_scan_spec_version_signed_off_check" CHECK (("signed_off_by_oid" IS NULL) = ("signed_off_at" IS NULL))
);
