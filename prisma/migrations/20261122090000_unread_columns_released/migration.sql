-- Columns nothing reads, which the application does not write:
--
--   * `virtual_agent.stop_detail` and `virtual_agent.stopped_at`;
--   * `delivery.delivered_at`;
--   * `agent_question.answer_message_id`;
--   * `assistant_conversation.jira_exported_at` and `assistant_conversation.confluence_exported_at`.
--
-- Each is nullable, as the previous build's Prisma client declares it, so that build reads the nulls this one leaves
-- while the two serve side by side. They are dropped by a later migration rather than here, because that build's
-- client names every column of its models in its selects and inserts. This build's client marks them `@ignore` in
-- prisma/schema.prisma, so it never names them and keeps working once they are gone.
--
-- `credential.updated_via` is not read either, but is still written: it is NOT NULL, and the previous build reads it
-- as never null.
--
-- Dropping a constraint locks its table ACCESS EXCLUSIVE, and dropping a foreign key locks the table it references
-- SHARE ROW EXCLUSIVE. Each lock waits 5 seconds at most, as `20261120090000_credential_kind_rebuilt` explains, and
-- all three are taken first.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "delivery", "agent_question" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "message" IN SHARE ROW EXCLUSIVE MODE;

-- The check tying `delivered_at` to the `delivered` state would refuse every ack, which leaves the column null. The
-- state alone is what the queue and the UI read.
ALTER TABLE "delivery" DROP CONSTRAINT "delivery_delivered_at_matches_state";

-- Its `ON DELETE SET NULL` scans `agent_question`, with no index to answer it, for every message deleted, to clear a
-- column nothing writes.
ALTER TABLE "agent_question" DROP CONSTRAINT "agent_question_answer_message_id_fkey";
