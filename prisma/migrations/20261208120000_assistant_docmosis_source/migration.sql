-- Where a version loaded from the template library came from: its path in the library and the git blob SHA-1 the
-- person picked, both checked against their own index when they picked it. Null for every other version, which a
-- session or the person's own edit wrote. See "Docmosis template library" in docs/agent-api.md.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "assistant_docmosis_version"
  ADD COLUMN "source_path"     TEXT CHECK (char_length("source_path") BETWEEN 1 AND 400),
  ADD COLUMN "source_blob_sha" TEXT CHECK ("source_blob_sha" ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT "assistant_docmosis_version_source" CHECK (("source_path" IS NULL) = ("source_blob_sha" IS NULL));
