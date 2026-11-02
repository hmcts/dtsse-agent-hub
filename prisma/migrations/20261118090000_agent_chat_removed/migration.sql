-- When the person removed the chat of this session on their own computer. A session with this set is never linked
-- another conversation (`linkLocalSession` in src/assistant/store.ts): removing the chat is the person saying they do
-- not want this session in their Assistant. A new session is a new agent row, with this null, and gets a chat of its own.
ALTER TABLE "agent" ADD COLUMN "chat_removed_at" timestamptz;
