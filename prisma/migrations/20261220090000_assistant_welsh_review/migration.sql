-- Two more Welsh job kinds: `review_list`, which lists the catalogue's rows awaiting review with every rendering of
-- their English, and `review_apply`, a draft pull request approving the ones a BA chose and superseding the rest.
--
-- Every existing row is one of the old kinds, which the new check also allows. It is added NOT VALID and validated
-- after, so the table is held only briefly against writes while its rows are checked.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_welsh_job" DROP CONSTRAINT "assistant_welsh_job_kind_check";

ALTER TABLE "assistant_welsh_job" ADD CONSTRAINT "assistant_welsh_job_kind_check" CHECK (
  "kind" IN ('info', 'search', 'scan', 'request', 'import_check', 'import', 'apply_preview', 'apply', 'story_candidates',
             'story_preview', 'story_write', 'keep_english', 'setup_check', 'setup', 'review_list', 'review_apply')
) NOT VALID;

ALTER TABLE "assistant_welsh_job" VALIDATE CONSTRAINT "assistant_welsh_job_kind_check";
