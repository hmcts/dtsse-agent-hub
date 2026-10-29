-- Where a conversation's title came from, where a session's name came from, and the one-off that gives the chats
-- carrying a handle instead of a name a name worth reading.
--
-- A local chat's title was decided once, when the session was linked, from the name its client reported — and at
-- that moment the client has nothing better than the session registry's handle, so the sidebar filled up with
-- `hmcts-1c` and `hmcts-25`. Nothing changed it afterwards except a rename. From now on the first prompt names it
-- (`refreshLocalTitle` in src/assistant/store.ts), and these two columns are what keep that from renaming a chat
-- out from under the person who named it.
--
-- `agent.name_source` is what the client now reports beside the name: `user` for a name the person chose with
-- Claude Code's `/rename`, `derived` for one the client worked out. A client from before the field says nothing,
-- which reads as `derived`, so every row here starts that way and a running session corrects its own within a
-- heartbeat. See src/agents/name-source.ts.
--
-- `assistant_conversation.title_source` is `TitleSource` in src/assistant/titles.ts: `agent` for the name a local
-- session reported, `message` for the first thing said in the chat, `user` for a title the person typed in the hub.
-- `message` is the default because that is where a chat on a pod gets its title — `touchConversation` names one
-- after its first message, and a fork takes the title of the chat it was copied from — and because it is also the
-- right value for a title this migration cannot attribute, as below: nothing automatic replaces one.
ALTER TABLE "agent"
  ADD COLUMN "name_source" text NOT NULL DEFAULT 'derived',
  ADD CONSTRAINT "agent_name_source_check" CHECK ("name_source" IN ('user', 'derived'));

ALTER TABLE "assistant_conversation"
  ADD COLUMN "title_source" text NOT NULL DEFAULT 'message',
  ADD CONSTRAINT "assistant_conversation_title_source_check" CHECK ("title_source" IN ('agent', 'message', 'user'));

-- Which of the local chats already here are provably carrying a name the client invented, and so may be renamed by
-- their own first prompt below. Only a chat with no pod can be: every other one was named from its first message,
-- which the default already says.
--
-- `name_source` is no help for this. It does not exist for a row written before this migration, so the column it
-- has just been given says `derived` for every session ever registered, including the ones the person renamed — a
-- default, not evidence. The only evidence left is the shape of the title, and the bar is deliberately high: a
-- title this does not recognise as a handle is left alone for good, because leaving a chat badly named can be put
-- right by a later migration and overwriting a name somebody chose cannot.
--
-- Two shapes, and both are the client's own fallbacks rather than handles in general:
--
--   * A prefix and two hex digits (`hmcts-25`, `summariser-cwd-9e`, `linus-57`), which is what Claude Code's
--     session registry derives from the working directory and the session id, and what `agentName` falls back to
--     when the transcript has no title it can read.
--   * Eight hex digits, which is `agentName`'s last resort, the start of the session id.
--
-- Measured against the 383 entries in one engineer's own session registry: all 372 names recorded `nameSource:
-- derived` match the first shape, and none of the 6 recorded `user` — the `/rename`s — match either, nor do the 5
-- Claude Code named itself (`nameSource: auto`, e.g. `local-sessions-as-conversations`). A `/rename` ending in two
-- hex digits (`pcs-ab`) would be caught, which is the residual risk and is why the shapes are this narrow rather
-- than "lower case and hyphens", which every `/rename` in that sample matches.
--
-- Everything else local keeps `message`: a title that may be the first thing said in the chat, a name the person
-- chose with `/rename`, a title they typed in the hub, or one Claude Code generated — the hub cannot tell which, and
-- `message` is the value whose rules are right for all four, since no prompt may replace one.
UPDATE "assistant_conversation" c
   SET "title_source" = 'agent'
 WHERE c."virtual_agent_id" IS NULL
   AND (c."title" IS NULL
        OR c."title" ~ '^[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{2}$'
        OR c."title" ~ '^[0-9a-f]{8}$');

-- The recovery: every local chat that is provably carrying a handle is named after its own first prompt.
--
-- This is the part people see. The sessions already backfilled by `20261114090000_backfill_local_conversations` took
-- their titles from the same handles, and those sessions have ended — they will not register again and will never
-- heartbeat again, so no better name is ever coming from their client. Their prompts are here, though, for as long
-- as `transcripts/sweep.ts` keeps them, which is what bounds this to the sessions whose words still exist.
--
-- `firstPromptTitle` and `PROMPT_CANDIDATES` in src/assistant/titles.ts are mirrored exactly, so a chat recovered
-- here is named what the running code would have named it: the earliest five prompts, the first of those with words
-- in it, and nothing from a redacted one — which holds the pattern the secret scanner matched and no words at all —
-- or from a hub message relayed into the session, which is a colleague's words and not what the chat is about. The
-- 60 is `TITLE_FROM_MESSAGE`.
--
-- Not announced: there is no connection to tell, and the next page load reads the rows.
WITH named AS (
  SELECT c."id",
         (SELECT NULLIF(LEFT(regexp_replace(btrim(p."content"->>'text'), '\s+', ' ', 'g'), 60), '')
            FROM (
              SELECT t."content", t."redacted", t."message_id", t."occurred_at", t."id"
                FROM "agent" a
                JOIN "transcript_entry" t ON t."agent_id" = a."id"
               WHERE a."assistant_conversation_id" = c."id"
                 AND t."role" = 'user'
               ORDER BY t."occurred_at", t."id"
               LIMIT 5
            ) p
           WHERE NOT p."redacted"
             AND p."message_id" IS NULL
             AND btrim(COALESCE(p."content"->>'text', '')) <> ''
           ORDER BY p."occurred_at", p."id"
           LIMIT 1) AS title
    FROM "assistant_conversation" c
   WHERE c."virtual_agent_id" IS NULL
     AND c."title_source" = 'agent'
)
UPDATE "assistant_conversation" c
   SET "title" = n.title, "title_source" = 'message'
  FROM named n
 WHERE c."id" = n."id" AND n.title IS NOT NULL;
