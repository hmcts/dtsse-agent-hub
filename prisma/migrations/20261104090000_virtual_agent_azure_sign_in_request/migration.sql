-- When the owner last asked this virtual agent to sign in to Azure, until its pod relays that sign-in. Azure is
-- optional, so a pod with no Azure sign-in stored relays a device code only when this is set, rather than on every
-- boot: the owner asks from their settings, the agent restarts, and its new pod finds the request here.
ALTER TABLE "virtual_agent" ADD COLUMN "azure_sign_in_requested_at" TIMESTAMPTZ(6);
