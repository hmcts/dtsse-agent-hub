-- Two more Welsh job kinds: `setup_check`, which reads a team's earlier translations into a throwaway catalogue to
-- show what setting the service up would make, and `setup`, a draft pull request adding the service's welsh/ folder
-- with its catalogue seeded from them.
--
-- Every existing row is one of the old kinds, which the new check also allows. It is added NOT VALID and validated
-- after, so the table is held only briefly against writes while its rows are checked.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_welsh_job" DROP CONSTRAINT "assistant_welsh_job_kind_check";

ALTER TABLE "assistant_welsh_job" ADD CONSTRAINT "assistant_welsh_job_kind_check" CHECK (
  "kind" IN ('info', 'search', 'scan', 'request', 'import_check', 'import', 'apply_preview', 'apply', 'story_candidates',
             'story_preview', 'story_write', 'keep_english', 'setup_check', 'setup')
) NOT VALID;

ALTER TABLE "assistant_welsh_job" VALIDATE CONSTRAINT "assistant_welsh_job_kind_check";
