-- A person's agents reach Claude two ways and no third: the HMCTS AI Gateway, on their own Azure sign-in, or their
-- own Claude licence. This release takes the pasted Amazon Bedrock API key out of the code and moves the rows that
-- depended on it. The `bedrock` label itself stays in both enums; see the note at the end.

-- A route is fixed on an agent's row when it is created, so a row made before the gateway existed still reads
-- `bedrock` and its pod boots on a key nothing can serve any more. The gateway is where its owner is now: it reaches
-- the same Bedrock models, and needs no key of theirs.
--
-- `generation` and `pod_generation` move with the route, because the route is in the pod template as
-- `AGENT_HUB_MODEL_ROUTE` and the orchestrator claims only rows whose `generation > observed_generation`. Without the
-- bump a pod that is already running keeps `bedrock` in its environment for the life of the pod: the route is read
-- once at boot, so its next session restart would ask the hub for a credential kind that no longer exists and sit in
-- a retry loop. This is the same pair `POD_CHANGE` in `src/virtual-agents/store.ts` bumps for every other write the
-- pod template carries, and `updated_at` goes with them as it does there.
UPDATE "virtual_agent"
   SET "model_route" = 'gateway',
       "generation" = "generation" + 1,
       "pod_generation" = "pod_generation" + 1,
       "updated_at" = now()
 WHERE "model_route" = 'bedrock';

-- The development and test value store, keyed by the same `secret_name` the metadata row carries. Before the
-- metadata rows, which are what names the values to remove.
DELETE FROM "dev_credential_value"
 WHERE "secret_name" IN (SELECT "secret_name" FROM "credential" WHERE "kind" = 'bedrock');

-- The metadata rows that say a key is held. In a deployed environment the value is in Key Vault rather than the
-- table above, and `u-<oid>-bedrock` is outside Postgres: no migration can reach it, and after this release no code
-- path can either, because `deleteCredential` builds that name from a kind the application no longer has. The
-- secrets are deleted by hand; see the Credentials section of the README.
DELETE FROM "credential" WHERE "kind" = 'bedrock';

-- A key was pasted rather than signed in for, so there should be no login row for one. Deleted because a row that
-- did exist would be a relayed sign-in for a kind no surface can offer and no save would be accepted for.
DELETE FROM "virtual_agent_login" WHERE "kind" = 'bedrock';

-- `bedrock` is deliberately left in `credential_kind` and `model_route`, and goes in the release after this one.
-- Postgres has no DROP VALUE, so removing it means rebuilding each type and moving its columns onto the
-- replacement — which changes the result-type OID of `credential.kind` and `virtual_agent.model_route`. The chart
-- runs two replicas and a pod migrates at boot, so this commits while the previous build is still serving: its
-- cached prepared statements would fail with `cached plan must not change result type` until every connection
-- cycled, and that build still accepts `PUT /api/agent/credentials/bedrock`, which the rebuilt enum would reject.
-- `20261104090000_assistant_model_choice` deferred a `DROP COLUMN` for the same reason. The TypeScript unions carry
-- only the live values from this release on, so nothing reads or writes the label either way.
