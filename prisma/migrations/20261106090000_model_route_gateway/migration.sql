-- The HMCTS AI Gateway route: Amazon Bedrock reached through the gateway on the owner's own Entra identity, with no
-- key of theirs to paste. `bedrock` stays, because an agent's route is fixed on its row when it is created and a row
-- already on it keeps booting on the key an administrator stored.
--
-- `AFTER` so the type's order matches `schema.prisma`'s. Adding a value inside a transaction is allowed from
-- Postgres 12 as long as nothing uses it in the same transaction, which is why this migration does nothing else.
ALTER TYPE "model_route" ADD VALUE 'gateway' AFTER 'bedrock';
