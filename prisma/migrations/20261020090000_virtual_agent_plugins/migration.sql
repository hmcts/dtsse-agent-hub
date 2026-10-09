-- The workspace plugins the owner ticked for the agent's pod to load, as a sorted array of names. The hub validates
-- each name against VIRTUAL_AGENT_PLUGINS (src/virtual-agents/plugins.ts); the check only bounds the shape.
ALTER TABLE "virtual_agent" ADD COLUMN "plugins" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "virtual_agent" ADD CONSTRAINT "virtual_agent_plugins_check" CHECK (
  jsonb_typeof("plugins") = 'array'
  AND jsonb_array_length("plugins") <= 20
);
