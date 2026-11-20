-- The title of the page a feedback thread was raised on, as the reviewer's browser had it, so the team's lists can name
-- a page the way people know it rather than by its path. Null for a thread raised before titles were sent, and for a
-- page with no title; the lists fall back to the path.
ALTER TABLE "feedback_thread" ADD COLUMN "page_title" TEXT;
