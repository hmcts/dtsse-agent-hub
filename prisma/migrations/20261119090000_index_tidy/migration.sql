-- Two indexes that only cost writes. Each is answered in full by a unique index on the same table, which every
-- query that could use one of these can use instead:
--
--   * `assistant_template_owner_idx` is `(owner_oid, name)`, the same columns in the same order as
--     `assistant_template_owner_name_key`;
--   * `virtual_agent_owner_oid_idx` is `(owner_oid)`, the leading column of `virtual_agent_owner_oid_name_key`.
--
-- Dropping an index locks its table ACCESS EXCLUSIVE. Each lock waits 5 seconds at most, as
-- `20261120090000_credential_kind_rebuilt` explains, and both are taken first, in one statement.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "assistant_template", "virtual_agent" IN ACCESS EXCLUSIVE MODE;

DROP INDEX "assistant_template_owner_idx";
DROP INDEX "virtual_agent_owner_oid_idx";
