-- A GitHub repository's name may start with a dot, as `hmcts/.github` does, but is never `.` or `..`. The checks the
-- GitHub export added refused every name starting with a dot; these take the rule src/assistant/github.ts holds.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_conversation"
  DROP CONSTRAINT "assistant_conversation_github_repo_check",
  ADD CONSTRAINT "assistant_conversation_github_repo_check" CHECK (
    "github_repo" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$' AND "github_repo" !~ '/\.\.?$'
  );

ALTER TABLE "assistant_export_default"
  DROP CONSTRAINT "assistant_export_default_github_repo_check",
  ADD CONSTRAINT "assistant_export_default_github_repo_check" CHECK (
    "github_repo" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$' AND "github_repo" !~ '/\.\.?$'
  );
