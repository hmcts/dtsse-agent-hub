-- Owner-wide access to a person's agents is gone, so the table that carried it goes with it.
--
-- `agent_grant` was one row per pair of people, covering every agent the owner had, now and later. Three things
-- replaced what it was used for, and none of them is a grant over agents:
--
--   * reaching somebody else's session is a tagged post (`message_tag`), which needs no row at all, because a post
--     is on a board everyone signed in can read;
--   * reading one of somebody's chats is `assistant_conversation_share`, decided one conversation at a time by the
--     person whose chat it is;
--   * everything else about an agent — seeing it, messaging it, its skills, its transcript, its thread — is its
--     owner's, and is now answered from `agent.owner_oid` alone.
--
-- The rows are dropped rather than migrated into conversation shares. A grant said "you may see my sessions", which
-- is not a statement about any particular chat, so there is no conversation it could name; and what it conveyed is
-- deliberately not being preserved. People re-share the chats they want to share.
--
-- `grant_level` goes too: it was this table's `level` column and nothing else used it. Dropped after the table, since
-- the type cannot go while a column is still declared with it.
DROP TABLE "agent_grant";

DROP TYPE "grant_level";
