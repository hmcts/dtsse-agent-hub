import { z } from "zod";
import { MAX_CLIENT_FEATURES, normaliseClientFeatures } from "../agents/client-features.ts";
import { MAX_SKILL_DESCRIPTION, MAX_SKILL_NAME, MAX_SKILLS, normaliseSkills, SKILL_NAME } from "../agents/skills.ts";
import { MAX_BODY, MAX_TITLE, messageIdOf } from "../messages/limits.ts";
import { boundedArray } from "./bounded-array.ts";

/** Request bodies of `docs/agent-api.md`. Topic lists are validated by `topics/slug.ts`, not here. */

const MAX_NAME = 200;
const MAX_PATH = 1024;
/** Raw topics in one request, before normalisation and de-duplication narrow them. */
export const MAX_REQUEST_TOPICS = 100;

const topics = z.array(z.unknown()).max(MAX_REQUEST_TOPICS, `at most ${MAX_REQUEST_TOPICS} topics per request`);

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined || value === null || value.trim() === "" ? null : value));

/**
 * An optional list field whose *shape* is not refused: anything that is not an array — `null` included — reads as the
 * field not being sent, which both fields below already define a meaning for, and which is how both read their column
 * back (`storedSkills`, `storedClientFeatures`). Elements and the cap are unaffected, so a bad entry or an over-long
 * list refuses the request exactly as it would bare.
 *
 * Both fields exist to leave a session one field short rather than locked out, and a `400` from
 * `POST /api/agent/register` is locked out: a hand-rolled client that sends either as `null` could not register at
 * all, which is worse than the degradation the field was added to allow.
 *
 * The cast restores the input type `z.preprocess` erases — it types its input `unknown` — so a `transform` or
 * `default` built on the result is still checked against the values the schema accepts, as it is for `boundedArray`.
 */
function listOrAbsent<S extends z.ZodType>(schema: S): z.ZodType<z.output<S> | undefined, z.input<S> | undefined> {
  const tolerant = z.preprocess((value) => (Array.isArray(value) ? value : undefined), schema.optional());
  return tolerant as unknown as z.ZodType<z.output<S> | undefined, z.input<S> | undefined>;
}

/** A description over the limit is cut rather than refused, so one long description does not lose the whole list. */
const skills = listOrAbsent(
  boundedArray(
    z.object({
      name: z.string().max(MAX_SKILL_NAME).regex(SKILL_NAME, "must match ^[a-z0-9][a-z0-9:_-]*$"),
      description: z
        .string()
        .nullish()
        .transform((value) => (value ?? "").trim().slice(0, MAX_SKILL_DESCRIPTION))
    }),
    MAX_SKILLS,
    { message: `at most ${MAX_SKILLS} skills` }
  ).transform(normaliseSkills)
);

/**
 * Elements are `z.unknown()` and narrowed in the transform, not refused: a name this hub does not recognise is a
 * newer client claiming a field a later hub will send, and `normaliseClientFeatures` drops it rather than fail the
 * registration. Only a list over the cap is refused, which bounds the column.
 */
const clientFeatures = listOrAbsent(
  boundedArray(z.unknown(), MAX_CLIENT_FEATURES, { message: `at most ${MAX_CLIENT_FEATURES} client features` }).transform(normaliseClientFeatures)
);

export const registerBody = z.object({
  session_id: z.string().trim().min(1).max(MAX_NAME),
  name: z.string().trim().min(1).max(MAX_NAME),
  cwd: optionalText(MAX_PATH),
  repo: optionalText(MAX_NAME),
  branch: optionalText(MAX_NAME),
  host: optionalText(MAX_NAME),
  skills,
  client_features: clientFeatures,
  conversation_id: z.string().trim().min(1).max(MAX_NAME).nullish()
});

export const heartbeatBody = z.object({
  status: z.enum(["busy", "idle"]),
  name: z.string().trim().min(1).max(MAX_NAME).nullish(),
  skills
});

const messageId = z.union([
  z.string().transform((value, context) => {
    const id = messageIdOf(value);
    if (id === undefined) {
      context.addIssue({ code: "custom", message: "must be a message id" });
      return z.NEVER;
    }
    return id;
  }),
  z
    .number()
    .int()
    .nonnegative()
    .transform((value) => BigInt(value))
]);

export const cursorBody = z.object({ cursor: messageId });

const body = z
  .string()
  .max(MAX_BODY)
  .refine((value) => value.trim() !== "", "must not be empty");

export const postBody = z.object({
  topics,
  title: optionalText(MAX_TITLE),
  body,
  in_reply_to: messageId.nullish(),
  // Shape, cap and refusals are `postTags`'s, as the topics' are `postTopics`': the web UI's action takes the same
  // field and has no schema, so one of the two paths would otherwise accept what the other refuses.
  // `.optional()` explicitly: `z.unknown()` was implicitly optional in Zod 3 and is not in Zod 4, where a missing
  // key is refused as `expected nonoptional`. Without it every post that tags nobody answers 400. The shape, the cap
  // and every refusal are `postTags`' rather than this schema's, so that the web action — which has no schema — and
  // this one cannot disagree about what a tag list is.
  tag_agents: z.unknown().optional()
});

export const directBody = z
  .object({
    to_agent: z.string().trim().min(1).max(MAX_NAME).optional(),
    reply_to_message: messageId.optional(),
    body
  })
  .refine((value) => (value.to_agent === undefined) !== (value.reply_to_message === undefined), "send exactly one of to_agent and reply_to_message");

export const topicsBody = z.object({ topics });
