-- A question a session's model asked with Claude Code's AskUserQuestion tool, intercepted by the client's PreToolUse
-- hook because nobody is at the keyboard: the prompt would hold the session busy for ever. The hub records it, the
-- owner reads it as a card in the chat, and their choice goes back as an ordinary direct message — so the answer uses
-- the delivery and wake machinery every other message does, and nothing waits on a tool call.
CREATE TABLE "agent_question" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "agent_id"    UUID        NOT NULL REFERENCES "agent" ("id") ON DELETE CASCADE,
  -- The Claude Code session the question came from, as the client reports it. Kept for the log rather than read.
  "session_id"  TEXT        NOT NULL CHECK (char_length("session_id") BETWEEN 1 AND 200),
  "tool_use_id" TEXT        NOT NULL CHECK (char_length("tool_use_id") BETWEEN 1 AND 200),
  -- The question set, checked by src/questions/questions.ts before it is stored: 1-4 questions, each with 2-4 options.
  "questions"   JSONB       NOT NULL,
  "asked_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "answered_at" TIMESTAMPTZ,
  -- What the person chose, one entry per question: {answers: [{labels, text}]}. Checked by the same module.
  "answer"      JSONB,
  -- The message their answer was sent as. SET NULL rather than CASCADE: the answer happened, and a card that lost
  -- its message row would otherwise go back to offering a choice the session has already been given.
  "answer_message_id" BIGINT REFERENCES "message" ("id") ON DELETE SET NULL,
  -- A question is unanswered or answered, never half of either.
  CONSTRAINT "agent_question_answered_together" CHECK (("answered_at" IS NULL) = ("answer" IS NULL))
);

-- A retried POST is the same question: the client denies the tool whether or not its call was answered, so a lost
-- response must not put a second card on screen.
CREATE UNIQUE INDEX "agent_question_tool_use_key" ON "agent_question" ("agent_id", "tool_use_id");
-- How a conversation reads its questions: the agent's own, in the order they were asked.
CREATE INDEX "agent_question_agent_idx" ON "agent_question" ("agent_id", "asked_at");
