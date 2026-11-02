-- Labels no code path writes, taken out of their types. Postgres has no DROP VALUE, so each type is rebuilt: the old
-- one is renamed aside, the replacement takes its name, the columns move across through text, and the old one is
-- dropped. Every label a column holds after the rows below are moved is in its replacement, so no cast can fail.
--
-- The rebuild rewrites `credential`, `virtual_agent_login` and `virtual_agent` under an ACCESS EXCLUSIVE lock, which
-- the build still serving waits on for as long as the rewrite runs. Its statements name each type, which keeps its
-- name, and the Prisma adapter prepares them unnamed, so nothing it holds is planned against the old type.
--
-- A lock queued behind a long transaction would hold every read of those tables behind it in turn, so each lock
-- waits 5 seconds at most. Past that the migration fails and rolls back, the migrator exits non-zero, and the pod's
-- container restarts and tries again, while the build already serving carries on.
SET LOCAL lock_timeout = '5s';

-- `bedrock`: the pasted Amazon Bedrock API key and the route that used it. `20261107090000_bedrock_gone` moved every
-- row off both labels; these repeat its moves so the casts below cannot meet one. The generations move with the
-- route because the route is in the pod template, as `POD_CHANGE` in src/virtual-agents/store.ts moves them.
UPDATE "virtual_agent"
   SET "model_route" = 'gateway',
       "generation" = "generation" + 1,
       "pod_generation" = "pod_generation" + 1,
       "updated_at" = now()
 WHERE "model_route" = 'bedrock';
DELETE FROM "dev_credential_value"
 WHERE "secret_name" IN (SELECT "secret_name" FROM "credential" WHERE "kind" = 'bedrock');
DELETE FROM "credential" WHERE "kind" = 'bedrock';
DELETE FROM "virtual_agent_login" WHERE "kind" = 'bedrock';

-- `quota` and `expired`: stop reasons the sweep and the owner's stop have never given. A row carrying one would read
-- as no reason, which is what it would read as to the application anyway.
UPDATE "virtual_agent" SET "stop_reason" = NULL WHERE "stop_reason" IN ('quota', 'expired');

ALTER TYPE "credential_kind" RENAME TO "credential_kind_retired";
CREATE TYPE "credential_kind" AS ENUM ('github', 'azure', 'claude', 'jenkins', 'claude_md', 'git_identity', 'atlassian');
ALTER TABLE "credential" ALTER COLUMN "kind" TYPE "credential_kind" USING "kind"::text::"credential_kind";
ALTER TABLE "virtual_agent_login" ALTER COLUMN "kind" TYPE "credential_kind" USING "kind"::text::"credential_kind";
DROP TYPE "credential_kind_retired";

ALTER TYPE "model_route" RENAME TO "model_route_retired";
CREATE TYPE "model_route" AS ENUM ('gateway', 'own_licence');
ALTER TABLE "virtual_agent" ALTER COLUMN "model_route" TYPE "model_route" USING "model_route"::text::"model_route";
DROP TYPE "model_route_retired";

ALTER TYPE "virtual_agent_stop_reason" RENAME TO "virtual_agent_stop_reason_retired";
CREATE TYPE "virtual_agent_stop_reason" AS ENUM ('user', 'idle', 'evening', 'failed', 'awaiting_owner');
ALTER TABLE "virtual_agent"
  ALTER COLUMN "stop_reason" TYPE "virtual_agent_stop_reason" USING "stop_reason"::text::"virtual_agent_stop_reason";
DROP TYPE "virtual_agent_stop_reason_retired";
