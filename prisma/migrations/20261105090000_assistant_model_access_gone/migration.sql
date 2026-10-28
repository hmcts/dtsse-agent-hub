-- The contract half of `20261104090000_assistant_model_choice`, which left both of these in place because the build
-- it deployed over still read them. That build is gone, so nothing reads either: a person's model is one row of
-- `assistant_model_choice`, and which models they are offered is no longer asked.
DROP TABLE "assistant_model_access";

ALTER TABLE "assistant_conversation"
  DROP COLUMN "model";
