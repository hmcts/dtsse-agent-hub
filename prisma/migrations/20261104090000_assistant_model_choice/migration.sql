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

-- Which models a person's credential answered, which is no longer asked: both models work on both model routes, so
-- there is nothing to discover and nothing to store.
DROP TABLE "assistant_model_access";

-- The model is the person's one setting now, not the conversation's.
ALTER TABLE "assistant_conversation"
  DROP COLUMN "model";
