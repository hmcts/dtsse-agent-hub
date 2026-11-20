-- Work Allocation specs for the WA builder: one row per saved version of a service's model. The model, its ordering
-- and its layout are kept as the YAML text `@hmcts-cft/wa-spec` writes, because that round-trips them without loss
-- and jsonb would reorder keys. Versions are append-only, numbered from 1 per service. See src/assistant/wa-builder-store.ts.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "wa_spec_version" (
  "service"      TEXT        NOT NULL CHECK ("service" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  "version"      INTEGER     NOT NULL CHECK ("version" >= 1),
  "display_name" TEXT        NOT NULL CHECK (char_length("display_name") BETWEEN 1 AND 200),
  "model"        TEXT        NOT NULL,
  "ordering"     TEXT,
  "layout"       TEXT,
  "saved_by"     TEXT        NOT NULL,
  "saved_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("service", "version")
);

CREATE FUNCTION wa_spec_version_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wa_spec_version rows are append-only';
END;
$$;

CREATE TRIGGER "wa_spec_version_append_only"
  BEFORE UPDATE OR DELETE ON "wa_spec_version"
  FOR EACH ROW EXECUTE FUNCTION wa_spec_version_append_only();
