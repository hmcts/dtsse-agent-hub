-- Which Claude models a person's own credential for a model route answered when their pod last asked, which is what
-- the Assistant's composer offers them. Per person and route, because the credential is: the `claude` token pays on
-- `own_licence` and the `bedrock` key on `bedrock`, and a person can have virtual agents on both.
--
-- Only definite answers are kept. A check that could not tell (a timeout, throttling, an outage) writes nothing, so it
-- never takes a model away; a model never answered either way has no row, and is not offered.
CREATE TABLE "assistant_model_access" (
  "owner_oid"   TEXT          NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "model_route" "model_route" NOT NULL,
  -- Checked in code against src/assistant/models.ts, so a model can be added without a migration.
  "model"       TEXT          NOT NULL CHECK ("model" ~ '^[a-z0-9-]{1,64}$'),
  "status"      TEXT          NOT NULL CHECK ("status" IN ('available', 'unavailable')),
  "checked_at"  TIMESTAMPTZ   NOT NULL,
  PRIMARY KEY ("owner_oid", "model_route", "model")
);
