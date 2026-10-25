-- Every answer the person stopped in this conversation, as [{"at": "<iso8601>"}], so the thread can show where each
-- one was cut off (src/assistant/thread.ts). A list rather than one timestamp because a conversation can be stopped
-- many times and each mark has its own place in the thread, which is exactly how `product_history` is kept.
--
-- NOT NULL with an empty default, so every existing conversation reads as never stopped without a backfill. Bounded
-- like `product_history`: the store keeps only the newest marks, and the check is what makes that a rule of the
-- table rather than of the one function that writes it.
ALTER TABLE "assistant_conversation" ADD COLUMN "stop_history" JSONB NOT NULL DEFAULT '[]' CHECK (
  jsonb_typeof("stop_history") = 'array' AND jsonb_array_length("stop_history") <= 50
);
