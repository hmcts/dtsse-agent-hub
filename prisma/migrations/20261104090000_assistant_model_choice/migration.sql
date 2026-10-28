-- The Claude model a person's chats run on: one choice each, for every chat they have, set in the Assistant's
-- settings. One row per person; no row means the default in src/assistant/models.ts.
CREATE TABLE "assistant_model_choice" (
  "owner_oid"  TEXT        NOT NULL PRIMARY KEY REFERENCES "user" ("oid") ON DELETE CASCADE,
  -- A bare family alias, `sonnet` or `opus`, checked in code against src/assistant/models.ts so the catalogue can
  -- change without a migration. The shape check is what keeps anything but a plain alias out of the launcher's
  -- command line and out of the `/model` keys on the pod.
  "model"      TEXT        NOT NULL CHECK ("model" ~ '^[a-z0-9-]{1,64}$'),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `assistant_model_access` and `assistant_conversation.model` are deliberately left in place. The chart runs two
-- replicas and a pod migrates at boot, so this commits while the previous build is still serving — and that build
-- reads both on every Assistant page load. Dropping them here would break it for the length of the rolling deploy
-- and make a rollback to it impossible. They go in the release after this one, when no replica reads them.
