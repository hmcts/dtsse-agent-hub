-- The Claude Code skills an agent's session reported it can run, as [{name, description}], for the web UI's "/"
-- autocomplete. The API validates each entry (src/agents/skills.ts); the check only bounds the shape.
ALTER TABLE "agent" ADD COLUMN "skills" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "agent" ADD CONSTRAINT "agent_skills_check" CHECK (
  jsonb_typeof("skills") = 'array'
  AND jsonb_array_length("skills") <= 200
);
