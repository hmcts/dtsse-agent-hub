-- One search of a person's Jira or Confluence, run in their pod with their twg sign-in so the hub holds no Atlassian
-- credentials: the hub records the question, the pod's supervisor answers it, and the request that asked waits for the
-- answer. A row only lives long enough to be answered: each new lookup deletes its assistant's rows over 10 minutes old.
CREATE TABLE "assistant_lookup" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "virtual_agent_id" UUID        NOT NULL REFERENCES "virtual_agent" ("id") ON DELETE CASCADE,
  "kind"             TEXT        NOT NULL CHECK ("kind" IN ('jira_project', 'confluence_page')),
  "query"            TEXT        NOT NULL CHECK (char_length("query") BETWEEN 1 AND 100),
  "space_key"        TEXT        CHECK ("space_key" ~ '^~?[A-Za-z0-9_-]{1,100}$'),
  "sign_in"          BOOLEAN     NOT NULL DEFAULT false,
  "status"           TEXT        NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'done', 'failed')),
  -- What the pod found, checked by src/assistant/lookups.ts before it is stored: at most 10 entries.
  "results"          JSONB,
  "error"            TEXT        CHECK ("error" IN ('signed_out', 'failed', 'superseded')),
  "detail"           TEXT        CHECK (char_length("detail") <= 300),
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "answered_at"      TIMESTAMPTZ
);

-- How lookups are counted for the rate limit and swept: an assistant's own, by age.
CREATE INDEX "assistant_lookup_agent_idx" ON "assistant_lookup" ("virtual_agent_id", "created_at");
