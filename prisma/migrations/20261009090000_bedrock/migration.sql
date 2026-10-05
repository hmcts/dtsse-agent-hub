-- A person's own Amazon Bedrock API key, pasted rather than signed in for, so it never has a virtual_agent_login row.
ALTER TYPE "credential_kind" ADD VALUE 'bedrock';

-- Virtual agents that used the HMCTS AI gateway call Amazon Bedrock directly instead. Renaming the value moves every
-- existing row with it.
ALTER TYPE "model_route" RENAME VALUE 'gateway' TO 'bedrock';
