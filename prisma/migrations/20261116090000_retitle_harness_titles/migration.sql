-- Chats named after text the harness wrote, not the person.
--
-- A local chat is named after its first prompt, and a session that opened with `/clear` (or a background task
-- reporting back) uploaded the harness's own record of it as that prompt, so the sidebar listed
-- `<command-name>/clear</command-name> <command-message>clear</…` and `<task-notification>…`. `firstPromptTitle`
-- now passes such turns over (`isHarnessTurn` in src/transcripts/harness-turn.ts); this puts right the chats that
-- were already named.
--
-- Each one is named after its own first prompt that the harness did not write, mirroring `firstPromptTitle` and
-- `PROMPT_CANDIDATES` (ten earliest prompts, not redacted, not a relayed hub message, with words in them, cut to
-- the 60 of `TITLE_FROM_MESSAGE`). A chat with no such prompt has its title cleared and goes back to `agent`, which
-- is what lets its next prompt name it. A title the person typed in the hub (`user`) is never touched.
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
               LIMIT 10
            ) p
           WHERE NOT p."redacted"
             AND p."message_id" IS NULL
             AND btrim(COALESCE(p."content"->>'text', '')) <> ''
             AND p."content"->>'text' !~ '^\s*(<(command-name>|command-message>|command-args>|local-command-|system-reminder>|task-notification>|bash-input>|bash-stdout>|bash-stderr>|user-prompt-submit-hook>)|\[Request interrupted by user)'
           ORDER BY p."occurred_at", p."id"
           LIMIT 1) AS title
    FROM "assistant_conversation" c
   WHERE c."virtual_agent_id" IS NULL
     AND c."title_source" <> 'user'
     AND c."title" ~ '^(<(command-name>|command-message>|command-args>|local-command-|system-reminder>|task-notification>|bash-input>|bash-stdout>|bash-stderr>|user-prompt-submit-hook>)|\[Request interrupted by user)'
)
UPDATE "assistant_conversation" c
   SET "title" = n.title,
       "title_source" = CASE WHEN n.title IS NULL THEN 'agent' ELSE 'message' END
  FROM named n
 WHERE c."id" = n."id";
