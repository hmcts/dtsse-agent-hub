-- Labels no code path writes, taken out of the two enums only `virtual_agent` uses: `bedrock` from `model_route`, and
-- `quota` and `expired` from `virtual_agent_stop_reason`, which the sweep and the owner's stop have never given.
-- Each type is rebuilt as `20261120090000_credential_kind_rebuilt` rebuilds its own, and both columns move in one
-- `ALTER TABLE`, so the table is rewritten once.
--
-- The lock waits 5 seconds at most, for the reason and with the outcome given there.
SET LOCAL lock_timeout = '5s';

-- `20261107090000_bedrock_gone` moved every row off `bedrock`; this repeats it so the cast below cannot meet one. The
-- generations move with the route because the route is in the pod template, as `POD_CHANGE` in
-- src/virtual-agents/store.ts moves them.
UPDATE "virtual_agent"
   SET "model_route" = 'gateway',
       "generation" = "generation" + 1,
       "pod_generation" = "pod_generation" + 1,
       "updated_at" = now()
 WHERE "model_route" = 'bedrock';

-- A row carrying one would read as no reason, which is what it reads as to the application anyway.
UPDATE "virtual_agent" SET "stop_reason" = NULL WHERE "stop_reason" IN ('quota', 'expired');

ALTER TYPE "model_route" RENAME TO "model_route_retired";
ALTER TYPE "virtual_agent_stop_reason" RENAME TO "virtual_agent_stop_reason_retired";
CREATE TYPE "model_route" AS ENUM ('gateway', 'own_licence');
CREATE TYPE "virtual_agent_stop_reason" AS ENUM ('user', 'idle', 'evening', 'failed', 'awaiting_owner');
ALTER TABLE "virtual_agent"
  ALTER COLUMN "model_route" TYPE "model_route" USING "model_route"::text::"model_route",
  ALTER COLUMN "stop_reason" TYPE "virtual_agent_stop_reason" USING "stop_reason"::text::"virtual_agent_stop_reason";
DROP TYPE "model_route_retired";
DROP TYPE "virtual_agent_stop_reason_retired";
