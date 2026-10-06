import { z } from "zod";
import { MAX_SKILL_DESCRIPTION, MAX_SKILL_NAME, MAX_SKILLS, normaliseSkills, SKILL_NAME } from "../agents/skills.ts";
import { MAX_BODY, MAX_TITLE, messageIdOf } from "../messages/limits.ts";

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

/** A description over the limit is cut rather than refused, so one long description does not lose the whole list. */
const skills = z
  .array(
    z.object({
      name: z.string().max(MAX_SKILL_NAME).regex(SKILL_NAME, "must match ^[a-z0-9][a-z0-9:_-]*$"),
      description: z
        .string()
        .nullish()
        .transform((value) => (value ?? "").trim().slice(0, MAX_SKILL_DESCRIPTION))
    })
  )
  .max(MAX_SKILLS, `at most ${MAX_SKILLS} skills`)
  .transform(normaliseSkills)
  .optional();

export const registerBody = z.object({
  session_id: z.string().trim().min(1).max(MAX_NAME),
  name: z.string().trim().min(1).max(MAX_NAME),
  cwd: optionalText(MAX_PATH),
  repo: optionalText(MAX_NAME),
  branch: optionalText(MAX_NAME),
  host: optionalText(MAX_NAME),
  skills
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
  in_reply_to: messageId.nullish()
});

export const directBody = z
  .object({
    to_agent: z.string().trim().min(1).max(MAX_NAME).optional(),
    reply_to_message: messageId.optional(),
    body
  })
  .refine((value) => (value.to_agent === undefined) !== (value.reply_to_message === undefined), "send exactly one of to_agent and reply_to_message");

export const topicsBody = z.object({ topics });
