-- Who may take their own copy of one HMCTS Assistant conversation and carry on with it in their own Assistant.
--
-- The same shape as `assistant_conversation_share`, and the same rule: a row names one person, the link only resolves
-- for someone named here, and removing a row is the whole of the revocation. A row also lets its recipient read the
-- conversation on its share page, because nobody can decide to continue a chat they have not seen.
--
-- A copy, once taken, is its recipient's own conversation and is not reached by removing the row: what was copied is
-- theirs, as a share page they already read is.
CREATE TABLE "assistant_conversation_fork" (
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  "recipient_oid"   TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  -- Always the conversation's owner at the time, as for a share.
  "shared_by_oid"   TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "recipient_oid")
);

CREATE INDEX "assistant_conversation_fork_recipient_idx" ON "assistant_conversation_fork" ("recipient_oid", "created_at");

-- A conversation that is a copy of someone else's: where it came from and the words copied out of it.
--
-- The source's name and title are copied rather than joined, so the copy still says whose chat it came from once the
-- source is deleted. `forked_thread` is the words only, as a share shows them, in src/assistant/forks.ts's shape.
-- `fork_context_sent_at` is set in the transaction of the first message sent in the copy, which is the message the
-- earlier turns go to the new session with.
ALTER TABLE "assistant_conversation"
  ADD COLUMN "forked_from_id"         UUID REFERENCES "assistant_conversation" ("id") ON DELETE SET NULL,
  ADD COLUMN "forked_from_owner_name" TEXT,
  ADD COLUMN "forked_from_title"      TEXT,
  ADD COLUMN "forked_at"              TIMESTAMPTZ,
  ADD COLUMN "forked_thread"          JSONB,
  ADD COLUMN "forked_earlier_hidden"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fork_context_sent_at"   TIMESTAMPTZ,
  ADD CONSTRAINT "assistant_conversation_fork_whole" CHECK (
    ("forked_at" IS NULL) = ("forked_thread" IS NULL) AND ("forked_at" IS NULL) = ("forked_from_owner_name" IS NULL)
  );

-- A recipient's own copy of one source, which taking the copy again finds rather than making a second.
CREATE INDEX "assistant_conversation_forked_from_idx" ON "assistant_conversation" ("owner_oid", "forked_from_id") WHERE "forked_from_id" IS NOT NULL;
