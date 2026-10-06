-- A person's own CLAUDE.md for their virtual agents, written rather than signed in for, so it never has a
-- virtual_agent_login row. It is kept with the credentials because people may put private context in it.
ALTER TYPE "credential_kind" ADD VALUE 'claude_md';
