-- What the client that registered this session claimed it understands of the hub's optional wire fields, as
-- ["name"], so the hub can leave out a field this client would silently ignore (src/agents/client-features.ts).
--
-- Nullable with no default, and NULL on purpose: a client from before `client_features` existed reports nothing, and
-- every row written before this column is in the same position. Absence is the "claims nothing" signal, so there is
-- no backfill and nothing to adopt. The API validates each name; the check only bounds the shape.
ALTER TABLE "agent" ADD COLUMN "client_features" JSONB;

ALTER TABLE "agent" ADD CONSTRAINT "agent_client_features_check" CHECK (
  "client_features" IS NULL
  OR (jsonb_typeof("client_features") = 'array' AND jsonb_array_length("client_features") <= 50)
);
