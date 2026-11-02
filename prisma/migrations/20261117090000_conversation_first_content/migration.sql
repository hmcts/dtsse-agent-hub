-- When something was first said or written in a conversation, which is what puts it in the sidebar and the search.
--
-- The lists used to work out from what a chat holds whether it had anything in it. What it holds does not last: a
-- transcript is swept after 30 days (`RETENTION_DAYS` in src/transcripts/limits.ts), so a chat on the person's own
-- computer whose words were only ever its transcript fell back out of the list a month after they last used it, and
-- the local sweep then collected it as though nothing had ever happened in it. This column is set once, by the write
-- that gives a conversation its first content (`announceFirstContent` in src/assistant/store.ts), and never cleared.
--
-- The backfill sets it for every conversation that has content now, by the rule the writes apply from here on: a
-- document, a fork's copied thread, a direct message to or from any of its agents, a question its session asked, an
-- answer or a tool call in its transcript, or a prompt the person typed. It is the earliest of those it can date by
-- the hub's own clock — a message's and a transcript entry's `created_at`, never the `occurred_at` a client sends —
-- and now() for a document from before `artefact_updated_at` was written.
--
-- In two passes, because this runs on boot under the startup probe. The first reads only indexed columns, each
-- source as the first matching row of its agent's own index in id order (`message_direct_target_idx`,
-- `message_author_agent_idx`, `agent_question_agent_idx`, `transcript_entry_agent_id_id_idx`), and settles almost
-- every chat with content. The second reads prompts, which costs a pattern match per entry, and so is asked only of
-- the chats the first left undated, stopping at each agent's first prompt that qualifies. A chat the first pass dated
-- can have had a prompt typed before its first answer, so its date can be a little late; nothing reads the column for
-- more than whether it is set.
--
-- A typed prompt is `isTypedPrompt` in src/transcripts/harness-turn.ts: not redacted, not a relayed hub message, and
-- words left once the IDE's editor context is taken off the front that are not a turn the harness wrote. The three
-- patterns below are that file's `IDE_CONTEXT_PATTERN`, `WORDS_PATTERN` and `HARNESS_TURN_PATTERN`, copied with
-- every character outside printable ASCII written as a \u escape. A migration is frozen, so they are a copy rather
-- than a reference; test/integration/migrate.test.ts holds this one to `isTypedPrompt`.
--
-- Not announced: there is no connection to tell, and the next page load reads the rows.
ALTER TABLE "assistant_conversation" ADD COLUMN "first_content_at" timestamptz;

WITH reached AS (
  SELECT a."assistant_conversation_id" AS id, min(LEAST(received.at, sent.at, asked.at, answered.at)) AS at
    FROM "agent" a
    LEFT JOIN LATERAL (
           SELECT x."created_at" AS at FROM "message" x
            WHERE x."kind" = 'direct' AND x."target_agent_id" = a."id" ORDER BY x."id" LIMIT 1
         ) received ON TRUE
    LEFT JOIN LATERAL (
           SELECT x."created_at" AS at FROM "message" x
            WHERE x."kind" = 'direct' AND x."author_agent_id" = a."id" ORDER BY x."id" LIMIT 1
         ) sent ON TRUE
    LEFT JOIN LATERAL (SELECT min(q."asked_at") AS at FROM "agent_question" q WHERE q."agent_id" = a."id") asked ON TRUE
    LEFT JOIN LATERAL (
           SELECT x."created_at" AS at FROM "transcript_entry" x
            WHERE x."agent_id" = a."id" AND x."role" IN ('assistant', 'tool_use') ORDER BY x."id" LIMIT 1
         ) answered ON TRUE
   WHERE a."assistant_conversation_id" IS NOT NULL
   GROUP BY a."assistant_conversation_id"
),
firsts AS (
  SELECT c."id",
         c."artefact_version" > 0 AS documented,
         LEAST(CASE WHEN c."artefact_version" > 0 THEN c."artefact_updated_at" END, c."forked_at", r.at) AS at
    FROM "assistant_conversation" c
    LEFT JOIN reached r ON r.id = c."id"
)
UPDATE "assistant_conversation" c
   SET "first_content_at" = COALESCE(f.at, now())
  FROM firsts f
 WHERE c."id" = f."id"
   AND (f.documented OR f.at IS NOT NULL);

-- `OFFSET 0` keeps the stripped text a subquery of its own, computed once per entry: without it the planner folds it
-- into the two tests below and strips each entry twice.
WITH prompted AS (
  SELECT a."assistant_conversation_id" AS id, min(p."created_at") AS created_at
    FROM "assistant_conversation" c
    JOIN "agent" a ON a."assistant_conversation_id" = c."id"
   CROSS JOIN LATERAL (
           SELECT t."created_at"
             FROM "transcript_entry" t
            CROSS JOIN LATERAL (SELECT regexp_replace(t."content"->>'text', '^(?:[\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*(?:<ide_opened_file>(?:(?!</ide_opened_file>)[\s\S])*</ide_opened_file>|<ide_selection>(?:(?!</ide_selection>)[\s\S])*</ide_selection>))+', '') AS typed OFFSET 0) s
            WHERE t."agent_id" = a."id"
              AND t."role" = 'user'
              AND t."message_id" IS NULL
              AND NOT t."redacted"
              AND s.typed ~ '[^\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
              AND s.typed !~ '^[\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*(?:<command-name>|<command-message>|<command-args>|<local-command-|<system-reminder>|<task-notification>|<bash-input>|<bash-stdout>|<bash-stderr>|<user-prompt-submit-hook>|\[Request interrupted by user)'
            ORDER BY t."id"
            LIMIT 1
         ) p
   WHERE c."first_content_at" IS NULL
   GROUP BY a."assistant_conversation_id"
)
UPDATE "assistant_conversation" c
   SET "first_content_at" = p."created_at"
  FROM prompted p
 WHERE c."id" = p."id";
