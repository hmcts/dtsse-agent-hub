-- The agents a post tagged: who it was written for, which is part of the post rather than part of its delivery.
--
-- Separate from the `delivery` row each tag also writes, although the two are written in the same transaction and
-- name the same agents, because they answer different questions: a delivery is transport and changes state as the
-- agent acks it or it expires, while this is what the post says and never changes. Reading the tags off the
-- deliveries would also mean a direct message's one delivery read back as a tag of its target.
--
-- The primary key is the only index it needs: every read is of one message's tags, which the message's own reads
-- join on. No ordinal column either — `toApiMessage` sorts the tags by name, as it does the topics.
CREATE TABLE "message_tag" (
  "message_id" BIGINT NOT NULL REFERENCES "message" ("id") ON DELETE CASCADE,
  "agent_id"   UUID   NOT NULL REFERENCES "agent" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("message_id", "agent_id")
);
