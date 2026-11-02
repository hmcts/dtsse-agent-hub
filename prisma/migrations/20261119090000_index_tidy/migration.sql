-- Two indexes that only cost writes. Each is answered in full by a unique index on the same table, which every
-- query that could use one of these can use instead:
--
--   * `assistant_template_owner_idx` is `(owner_oid, name)`, the same columns in the same order as
--     `assistant_template_owner_name_key`;
--   * `virtual_agent_owner_oid_idx` is `(owner_oid)`, the leading column of `virtual_agent_owner_oid_name_key`.
DROP INDEX "assistant_template_owner_idx";
DROP INDEX "virtual_agent_owner_oid_idx";
