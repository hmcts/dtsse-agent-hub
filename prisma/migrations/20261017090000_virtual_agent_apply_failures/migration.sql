-- How many claims in a row the orchestrator reported it could not apply. A successful observation, or the owner
-- starting, stopping or deleting the agent, sets it back to 0; at 5 the agent is failed.
ALTER TABLE "virtual_agent" ADD COLUMN "apply_failures" integer NOT NULL DEFAULT 0;
