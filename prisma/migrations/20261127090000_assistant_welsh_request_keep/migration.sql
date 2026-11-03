-- Two more Welsh job kinds: `request`, the Welsh Language Unit spreadsheet of only the new strings a BA ticked, and
-- `keep_english`, a draft pull request adding what they left out to the service's identical_allowlist.
--
-- Every existing row is one of the old kinds, which the new check also allows. The table is small (a week of jobs),
-- so checking its rows under the lock the swap takes anyway costs nothing worth splitting out.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_welsh_job" DROP CONSTRAINT "assistant_welsh_job_kind_check";

ALTER TABLE "assistant_welsh_job" ADD CONSTRAINT "assistant_welsh_job_kind_check" CHECK (
  "kind" IN ('info', 'search', 'scan', 'request', 'import_check', 'import', 'apply_preview', 'apply', 'story_candidates',
             'story_preview', 'story_write', 'keep_english')
);
