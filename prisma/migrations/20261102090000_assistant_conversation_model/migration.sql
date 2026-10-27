-- The Claude model a conversation runs on, which the person picks in the composer and its session is started and
-- switched to. Checked in code against src/assistant/models.ts, so a model can be added without a migration; the
-- shape check is what keeps anything but a plain id out of the launcher's command line on the pod.
ALTER TABLE "assistant_conversation"
  ADD COLUMN "model" TEXT NOT NULL DEFAULT 'claude-sonnet-5-5' CHECK ("model" ~ '^[a-z0-9-]{1,64}$');
