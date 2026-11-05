-- The sidebar reads an owner's pinned chats on every page load, apart from the recency read that
-- `assistant_conversation_owner_active_idx` serves. Partial, because few chats are ever pinned.
CREATE INDEX "assistant_conversation_owner_pinned_idx" ON "assistant_conversation" ("owner_oid", "pinned_at" DESC) WHERE "pinned_at" IS NOT NULL;
