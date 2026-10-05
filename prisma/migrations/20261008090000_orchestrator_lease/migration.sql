-- The cluster a virtual agent's StatefulSet and disk are on. Unlike `claimed_by`, which is cleared when the claim is
-- released, it stays set until another cluster's orchestrator claims the agent.
ALTER TABLE "virtual_agent" ADD COLUMN "cluster" TEXT;

UPDATE "virtual_agent" SET "cluster" = "claimed_by" WHERE "claimed_by" IS NOT NULL;

-- Which cluster's orchestrator may claim. Preview runs one per cluster during a switchover, and only the holder acts;
-- another takes the lease once the holder has stopped renewing it.
CREATE TABLE "orchestrator_lease" (
  "id"         SMALLINT       PRIMARY KEY,
  "cluster"    TEXT           NOT NULL,
  "renewed_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "orchestrator_lease_single_row" CHECK ("id" = 1)
);
