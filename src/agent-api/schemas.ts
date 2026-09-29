import { z } from "zod";

/** Request bodies of `docs/agent-api.md`. Topic lists are validated by `topics/slug.ts`, not here. */

const MAX_NAME = 200;
const MAX_PATH = 1024;
const MAX_TITLE = 300;
export const MAX_BODY = 32_000;
/** Raw topics in one request, before normalisation and de-duplication narrow them. */
export const MAX_REQUEST_TOPICS = 100;

const topics = z.array(z.unknown()).max(MAX_REQUEST_TOPICS, `at most ${MAX_REQUEST_TOPICS} topics per request`);

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => (value === undefined || value === null || value.trim() === "" ? null : value));

export const registerBody = z.object({
  session_id: z.string().trim().min(1).max(MAX_NAME),
  name: z.string().trim().min(1).max(MAX_NAME),
  cwd: optionalText(MAX_PATH),
  repo: optionalText(MAX_NAME),
  branch: optionalText(MAX_NAME),
  host: optionalText(MAX_NAME)
});

export const heartbeatBody = z.object({
  status: z.enum(["busy", "idle"]),
  name: z.string().trim().min(1).max(MAX_NAME).nullish()
});

const messageId = z.union([z.string().regex(/^\d{1,19}$/, "must be a message id"), z.number().int().nonnegative()]).transform((value) => BigInt(value));

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
