-- A person's Jenkins API token, pasted rather than signed in for, so it never has a virtual_agent_login row.
ALTER TYPE "credential_kind" ADD VALUE 'jenkins';
