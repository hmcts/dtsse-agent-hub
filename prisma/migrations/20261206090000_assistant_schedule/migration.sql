-- A person's schedule for their virtual agents: when the sweep starts their Assistant, and how long it waits before
-- stopping one of theirs for being idle. One row per person; no row means no auto start and the deployment's idle
-- period.
CREATE TABLE "assistant_schedule" (
  "owner_oid"          TEXT        NOT NULL PRIMARY KEY REFERENCES "user" ("oid") ON DELETE CASCADE,
  -- UK wall-clock `HH:MM`, checked in code against src/virtual-agents/schedule.ts so the slots can change without a
  -- migration. NULL is no auto start.
  "auto_start_time"    TEXT        CHECK ("auto_start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  -- One of IDLE_CHOICES in src/virtual-agents/schedule.ts. NULL is the deployment's VIRTUAL_AGENT_IDLE_MINUTES.
  "idle_after"         TEXT        CHECK ("idle_after" ~ '^([0-9]{1,2}h|never)$'),
  -- The UK date of the last auto start the sweep acted on, so it happens once a day.
  "last_auto_start_on" DATE,
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now()
);
