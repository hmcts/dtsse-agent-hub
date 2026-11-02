-- Columns nothing reads, which the application stops writing from this release:
--
--   * `virtual_agent.stop_detail` and `virtual_agent.stopped_at`;
--   * `credential.updated_via` (the Key Vault secret's `via` tag still records where a value was saved from);
--   * `delivery.delivered_at`;
--   * `agent_question.answer_message_id`;
--   * `assistant_conversation.jira_exported_at` and `assistant_conversation.confluence_exported_at`.
--
-- They are dropped by a later migration rather than here, because two replicas migrate at boot while the previous
-- build still serves, and that build's Prisma client names every column of its models in its selects and inserts.
-- This release's client marks them `@ignore` in prisma/schema.prisma, so it never names them and keeps working once
-- they are gone.
--
-- What this release has to change is the two rules that would refuse a row it writes without them.

-- Not null with no default, so an insert that leaves it out would fail.
ALTER TABLE "credential" ALTER COLUMN "updated_via" DROP NOT NULL;

-- The check tying `delivered_at` to the `delivered` state would refuse every ack, which leaves the column null. The
-- state alone is what the queue and the UI read.
ALTER TABLE "delivery" DROP CONSTRAINT "delivery_delivered_at_matches_state";
