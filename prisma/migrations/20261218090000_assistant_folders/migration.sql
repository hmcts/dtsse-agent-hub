-- A folder a person groups their own chats under. Only a label for now: a chat is in one folder or none, and the
-- folder carries nothing of its own to the chats' sessions. Deleting a folder keeps its chats, out of any folder.
CREATE TABLE "assistant_folder" (
  "id"         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_oid"  TEXT        NOT NULL REFERENCES "user" ("oid") ON DELETE CASCADE,
  "name"       TEXT        NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "assistant_folder_owner_idx" ON "assistant_folder" ("owner_oid", "name");

ALTER TABLE "assistant_conversation"
  ADD COLUMN "folder_id" UUID REFERENCES "assistant_folder" ("id") ON DELETE SET NULL;
CREATE INDEX "assistant_conversation_folder_idx" ON "assistant_conversation" ("folder_id", "last_active_at" DESC)
  WHERE "folder_id" IS NOT NULL;
