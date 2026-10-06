-- A person's override of the git user.name and user.email their virtual agents commit as, JSON of both, either
-- optional. Written rather than signed in for, so it never has a virtual_agent_login row.
ALTER TYPE "credential_kind" ADD VALUE 'git_identity';
