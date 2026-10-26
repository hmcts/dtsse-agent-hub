-- How many conversation sessions the pod says it runs at once, from the `max` its supervisor already sends with every
-- sessions report. The hub has no other way to know it: the cap is baked into the pod template as
-- AGENT_HUB_MAX_SESSIONS, so a deploy that changes the constant reaches a pod only when it next rolls, and until then
-- the pod in front of the person enforces the figure it booted with.
--
-- Nullable, because "the pod has not said" is not the same as a cap of zero, and anything shown to a person falls back
-- to the size's constant only until it has.
ALTER TABLE "virtual_agent"
  ADD COLUMN "sessions_max" INTEGER CHECK ("sessions_max" > 0);
