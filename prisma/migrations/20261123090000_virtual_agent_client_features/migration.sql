-- What the client a virtual agent's pod booted on claimed it understands of the hub's optional wire fields, as
-- ["name"], reported with every POST /api/virtual/{id}/status (src/agents/client-features.ts, `podSupports`).
--
-- Nullable with no default, so adding it is a catalogue change and rewrites nothing. NULL is a pod whose client
-- does not report a claim, for which the hub reads the claim of the pod's main-session agent instead. The API
-- validates each name; the check only bounds the shape, as it does for agent.client_features.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "virtual_agent" ADD COLUMN "client_features" JSONB;

ALTER TABLE "virtual_agent" ADD CONSTRAINT "virtual_agent_client_features_check" CHECK (
  "client_features" IS NULL
  OR (jsonb_typeof("client_features") = 'array' AND jsonb_array_length("client_features") <= 50)
);
