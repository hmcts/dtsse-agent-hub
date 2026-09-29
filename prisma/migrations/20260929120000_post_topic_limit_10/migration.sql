-- A post now carries 1–10 topics; a direct message still carries none. Only the function body changes: both
-- constraint triggers call it by name, so they pick the new rule up without being recreated.
CREATE OR REPLACE FUNCTION "message_topic_count_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  checked BIGINT[];
  checked_id BIGINT;
  checked_kind "message_kind";
  topic_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'message' THEN
    checked := ARRAY[NEW."id"];
  ELSIF TG_OP = 'INSERT' THEN
    checked := ARRAY[NEW."message_id"];
  ELSIF TG_OP = 'DELETE' THEN
    checked := ARRAY[OLD."message_id"];
  ELSE
    checked := ARRAY[OLD."message_id", NEW."message_id"];
  END IF;

  FOREACH checked_id IN ARRAY checked LOOP
    SELECT "kind" INTO checked_kind FROM "message" WHERE "id" = checked_id;
    -- Deleted in the same transaction; the cascade removed its topics with it.
    CONTINUE WHEN NOT FOUND;

    SELECT count(*) INTO topic_count FROM "message_topic" WHERE "message_id" = checked_id;

    IF checked_kind = 'post' AND (topic_count < 1 OR topic_count > 10) THEN
      RAISE EXCEPTION 'post % has % topics; a post needs between 1 and 10', checked_id, topic_count
        USING ERRCODE = 'check_violation', CONSTRAINT = 'message_topic_count';
    END IF;
    IF checked_kind = 'direct' AND topic_count <> 0 THEN
      RAISE EXCEPTION 'direct message % has % topics; a direct message has none', checked_id, topic_count
        USING ERRCODE = 'check_violation', CONSTRAINT = 'message_topic_count';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
