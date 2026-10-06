-- A person's Atlassian Teamwork Graph CLI (twg) sign-in, its auth.conf without the access token. Optional, and signed
-- in for with a device code the pod relays, so it has virtual_agent_login rows like github and azure.
ALTER TYPE "credential_kind" ADD VALUE 'atlassian';
