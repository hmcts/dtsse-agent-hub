-- Who, besides its owner, may read one HMCTS Assistant conversation.
--
-- A row is an explicit, named grant of read-only access to one conversation. There is no row for "anyone with the
-- link" and none for "anyone in the tenant": the link an owner copies only resolves for someone named here, so the
-- list is the whole of the access and removing a row is the whole of the revocation.
--
-- Per conversation rather than per owner, which is why this is not `agent_grant`: that table covers every agent its
-- owner has, now and later, and a conversation is one private chat the owner chose to show.
CREATE TABLE "assistant_conversation_share" (
  "conversation_id" UUID        NOT NULL REFERENCES "assistant_conversation" ("id") ON DELETE CASCADE,
  -- The person it is shared with. They have to have used the hub, as a grantee of `agent_grant` does, so an owner
  -- cannot share with an address nobody will ever read. Deleting either side removes the share with it.
  "recipient_oid"   TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  -- Who shared it, which is always the conversation's owner at the time. Kept so a share can be explained later.
  "shared_by_oid"   TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversation_id", "recipient_oid")
);

-- The recipient's read: every conversation shared with them.
CREATE INDEX "assistant_conversation_share_recipient_idx" ON "assistant_conversation_share" ("recipient_oid", "created_at");
