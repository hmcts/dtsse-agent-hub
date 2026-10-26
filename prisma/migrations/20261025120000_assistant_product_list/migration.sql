-- The product list is now the CFT workspace's `apps/` products (src/assistant/products.ts), with `general` the
-- catch-all in place of `other`. The column's check already admits every new slug, so only the default moves.
ALTER TABLE "assistant_conversation" ALTER COLUMN "product" SET DEFAULT 'general';

-- `other` is no longer offered, so a conversation left on it would show as the raw slug and match no option in the
-- product picker. `product_history` keeps it: it records what was actually picked, and a retired slug there shows as
-- itself in the thread.
UPDATE "assistant_conversation" SET "product" = 'general' WHERE "product" = 'other';
