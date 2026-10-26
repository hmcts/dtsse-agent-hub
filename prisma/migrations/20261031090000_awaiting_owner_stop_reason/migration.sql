-- The sweep's stop for an agent whose pod sat waiting for its owner to finish a sign-in, or to store a credential it
-- has none of. Its own reason rather than 'idle' because the agent was not idle, it was asking, and its owner's page
-- has to say which of the two happened.
ALTER TYPE "virtual_agent_stop_reason" ADD VALUE 'awaiting_owner';
