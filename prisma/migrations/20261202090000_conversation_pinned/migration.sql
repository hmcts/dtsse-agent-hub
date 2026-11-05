-- When the person pinned a conversation, which keeps it in the sidebar's Pinned section above the date groups, most
-- recently pinned first; null for a chat that is not pinned. Set and cleared only by its owner, from the chat's menu.
ALTER TABLE "assistant_conversation" ADD COLUMN "pinned_at" timestamptz;
