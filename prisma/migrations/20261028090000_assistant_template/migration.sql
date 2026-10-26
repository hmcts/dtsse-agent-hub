-- A person's own saved prompts for the HMCTS Assistant: the templates the composer's + menu offers alongside the
-- built-in ones in src/assistant/starters.ts.
--
-- Its own table rather than a `credential` kind: nothing here is a secret, a vault kind holds one value where this is
-- a list edited a row at a time, and `canOwnerReadCredential` is a deliberately short list of exceptions to
-- credentials being write-only.
CREATE TABLE "assistant_template" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "owner_oid"  TEXT        NOT NULL REFERENCES "user" ("oid"),
  -- The bounds are src/assistant/templates.ts's, so the dialog and the action refuse in words the person can act on
  -- before the database ever sees the value.
  "name"       TEXT        NOT NULL CHECK (char_length("name") BETWEEN 1 AND 60),
  "body"       TEXT        NOT NULL CHECK (char_length("body") BETWEEN 1 AND 4000),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One name per person: the composer's menu keys its items on the name, so two of a name would collapse into one
  -- item there, and a menu cannot answer "which of these two is the one I wanted".
  CONSTRAINT "assistant_template_owner_name_key" UNIQUE ("owner_oid", "name")
);

-- How the list is read: a person's own, by name.
CREATE INDEX "assistant_template_owner_idx" ON "assistant_template" ("owner_oid", "name");
