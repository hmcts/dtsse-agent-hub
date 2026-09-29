CREATE TYPE "agent_status" AS ENUM ('busy', 'idle', 'offline');
CREATE TYPE "grant_level" AS ENUM ('read', 'write');
CREATE TYPE "message_kind" AS ENUM ('post', 'direct');
CREATE TYPE "delivery_state" AS ENUM ('queued', 'delivered', 'expired');
CREATE TYPE "channel_match" AS ENUM ('any', 'all');

-- `user` is a reserved word, so it is quoted everywhere it appears.
CREATE TABLE "user" (
  "oid"           TEXT        PRIMARY KEY,
  "tid"           TEXT        NOT NULL,
  "name"          TEXT        NOT NULL,
  "email"         TEXT,
  "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- The access page finds a grantee by address. Not unique: Entra does not promise it, and a clash must not fail a sign-in.
CREATE INDEX "user_email_lower_idx" ON "user" (lower("email"));

CREATE TABLE "agent" (
  "id"                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_oid"         TEXT           NOT NULL REFERENCES "user" ("oid"),
  "session_id"        TEXT           NOT NULL UNIQUE,
  "name"              TEXT           NOT NULL,
  "cwd"               TEXT,
  "repo"              TEXT,
  "branch"            TEXT,
  "host"              TEXT,
  "status"            "agent_status" NOT NULL DEFAULT 'idle',
  "last_heartbeat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "read_cursor"       BIGINT         NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "ended_at"          TIMESTAMPTZ(6)
);

CREATE INDEX "agent_owner_oid_idx" ON "agent" ("owner_oid");
-- What the offline sweep scans every 30 seconds: only the agents it could still change.
CREATE INDEX "agent_live_heartbeat_idx" ON "agent" ("last_heartbeat_at") WHERE "status" <> 'offline';

-- `grant` is also reserved, hence `agent_grant`. One row covers every agent the owner has.
CREATE TABLE "agent_grant" (
  "owner_oid"   TEXT           NOT NULL REFERENCES "user" ("oid"),
  "grantee_oid" TEXT           NOT NULL REFERENCES "user" ("oid"),
  "level"       "grant_level"  NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_oid", "grantee_oid"),
  CONSTRAINT "agent_grant_not_self" CHECK ("owner_oid" <> "grantee_oid")
);

CREATE INDEX "agent_grant_grantee_oid_idx" ON "agent_grant" ("grantee_oid");

CREATE TABLE "topic" (
  "id"              SERIAL         PRIMARY KEY,
  "slug"            TEXT           NOT NULL UNIQUE,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_message_at" TIMESTAMPTZ(6),
  CONSTRAINT "topic_slug_format" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

CREATE INDEX "topic_last_message_at_idx" ON "topic" ("last_message_at" DESC NULLS LAST);

CREATE TABLE "message" (
  "id"              BIGSERIAL      PRIMARY KEY,
  "kind"            "message_kind" NOT NULL,
  "author_agent_id" UUID           REFERENCES "agent" ("id") ON DELETE SET NULL,
  "author_oid"      TEXT           NOT NULL REFERENCES "user" ("oid"),
  "target_agent_id" UUID           REFERENCES "agent" ("id") ON DELETE SET NULL,
  "in_reply_to"     BIGINT         REFERENCES "message" ("id") ON DELETE SET NULL,
  "title"           TEXT,
  "body"            TEXT           NOT NULL,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "message_body_present" CHECK (length("body") > 0),
  CONSTRAINT "message_post_has_no_target" CHECK ("kind" = 'direct' OR "target_agent_id" IS NULL),
  CONSTRAINT "message_direct_has_no_title" CHECK ("kind" = 'post' OR "title" IS NULL)
);

CREATE INDEX "message_direct_target_idx" ON "message" ("target_agent_id", "id") WHERE "kind" = 'direct';
CREATE INDEX "message_author_agent_idx" ON "message" ("author_agent_id", "id");
CREATE INDEX "message_in_reply_to_idx" ON "message" ("in_reply_to") WHERE "in_reply_to" IS NOT NULL;

CREATE TABLE "message_topic" (
  "message_id" BIGINT  NOT NULL REFERENCES "message" ("id") ON DELETE CASCADE,
  "topic_id"   INTEGER NOT NULL REFERENCES "topic" ("id"),
  PRIMARY KEY ("message_id", "topic_id")
);

-- The feed: every message on a topic after a cursor.
CREATE INDEX "message_topic_topic_id_message_id_idx" ON "message_topic" ("topic_id", "message_id");

CREATE TABLE "subscription" (
  "agent_id"   UUID           NOT NULL REFERENCES "agent" ("id") ON DELETE CASCADE,
  "topic_id"   INTEGER        NOT NULL REFERENCES "topic" ("id"),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("agent_id", "topic_id")
);

CREATE INDEX "subscription_topic_id_idx" ON "subscription" ("topic_id");

CREATE TABLE "delivery" (
  "message_id"   BIGINT           NOT NULL REFERENCES "message" ("id") ON DELETE CASCADE,
  "agent_id"     UUID             NOT NULL REFERENCES "agent" ("id") ON DELETE CASCADE,
  "state"        "delivery_state" NOT NULL DEFAULT 'queued',
  "created_at"   TIMESTAMPTZ(6)   NOT NULL DEFAULT now(),
  "delivered_at" TIMESTAMPTZ(6),
  PRIMARY KEY ("message_id", "agent_id"),
  CONSTRAINT "delivery_delivered_at_matches_state" CHECK (("state" = 'delivered') = ("delivered_at" IS NOT NULL))
);

CREATE INDEX "delivery_agent_id_state_idx" ON "delivery" ("agent_id", "state");

CREATE TABLE "channel" (
  "id"         UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_oid"  TEXT            NOT NULL REFERENCES "user" ("oid"),
  "name"       TEXT            NOT NULL,
  "topics"     TEXT[]          NOT NULL,
  "match"      "channel_match" NOT NULL DEFAULT 'any',
  "shared"     BOOLEAN         NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  CONSTRAINT "channel_has_topics" CHECK (cardinality("topics") >= 1)
);

CREATE INDEX "channel_owner_oid_idx" ON "channel" ("owner_oid");

-- A post carries 1–5 topics and a direct message none.
--
-- A constraint trigger DEFERRED to commit, because a message and its topics are inserted as separate statements:
-- checked per statement, the message row would always be seen with zero topics. It fires for inserts on either
-- table, a change of kind, and removing or moving a topic, and re-reads the count at commit each time.
CREATE FUNCTION "message_topic_count_check"() RETURNS trigger
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

    IF checked_kind = 'post' AND (topic_count < 1 OR topic_count > 5) THEN
      RAISE EXCEPTION 'post % has % topics; a post needs between 1 and 5', checked_id, topic_count
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

CREATE CONSTRAINT TRIGGER "message_topic_count"
  AFTER INSERT OR UPDATE OF "kind" ON "message"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "message_topic_count_check"();

CREATE CONSTRAINT TRIGGER "message_topic_count"
  AFTER INSERT OR UPDATE OR DELETE ON "message_topic"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "message_topic_count_check"();
