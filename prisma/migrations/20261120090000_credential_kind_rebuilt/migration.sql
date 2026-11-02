-- `bedrock`, the pasted Amazon Bedrock API key, taken out of `credential_kind`. Postgres has no DROP VALUE, so the
-- type is rebuilt: the old one is renamed aside, the replacement takes its name, the columns move across through
-- text, and the old one is dropped.
--
-- `credential` and `virtual_agent_login` move together, in this one transaction. Prisma casts every enum parameter
-- by the type's name (`CAST($1::text AS "public"."credential_kind")`), so a commit between the two would leave one
-- column on a type of another name, and every query the serving build makes of it failing for want of an operator.
-- Both tables are locked first, in one statement, so neither rewrite starts while the other table is waited for.
--
-- A lock queued behind a long transaction holds every read of the table behind it in turn, so each lock waits 5
-- seconds at most. Past that the migration fails and rolls back, the migrator exits non-zero, and the pod's container
-- restarts and tries again, while the build already serving carries on.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "credential", "virtual_agent_login" IN ACCESS EXCLUSIVE MODE;

-- `20261107090000_bedrock_gone` deleted every row of this kind; these repeat it so the casts below cannot meet one.
DELETE FROM "dev_credential_value"
 WHERE "secret_name" IN (SELECT "secret_name" FROM "credential" WHERE "kind" = 'bedrock');
DELETE FROM "credential" WHERE "kind" = 'bedrock';
DELETE FROM "virtual_agent_login" WHERE "kind" = 'bedrock';

ALTER TYPE "credential_kind" RENAME TO "credential_kind_retired";
CREATE TYPE "credential_kind" AS ENUM ('github', 'azure', 'claude', 'jenkins', 'claude_md', 'git_identity', 'atlassian');
ALTER TABLE "credential" ALTER COLUMN "kind" TYPE "credential_kind" USING "kind"::text::"credential_kind";
ALTER TABLE "virtual_agent_login" ALTER COLUMN "kind" TYPE "credential_kind" USING "kind"::text::"credential_kind";
DROP TYPE "credential_kind_retired";
