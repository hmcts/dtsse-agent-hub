-- A person's Microsoft 365 connection: the Microsoft Graph refresh token the hub's own connect sign-in got for them,
-- as JSON with the account and the scopes granted. Optional, and written only by the hub's callback, so it never has
-- virtual_agent_login rows; a pod is given access tokens minted from it and never the value.
ALTER TYPE "credential_kind" ADD VALUE 'microsoft';
