import { z } from "zod";
import { messageIdOf } from "../messages/limits.ts";
import { contentBytes, ENTRY_KEY_PATTERN, MAX_BATCH_ENTRIES, MAX_ENTRY_CONTENT_BYTES, MAX_ENTRY_KEY, MAX_REDACTED_PATTERN, MAX_SESSION_ID } from "./limits.ts";

/** The body of `POST /api/agent/{agent_id}/transcript` and the `Transcript entry` type of `docs/agent-api.md`. */

export const TRANSCRIPT_ROLES = ["user", "assistant", "tool_use", "tool_result", "system"] as const;

export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

export interface TextContent {
  text: string;
}

export interface ToolUseContent {
  id: string;
  name: string;
  input?: unknown;
}

export interface ToolResultContent {
  tool_use_id: string;
  output: string;
  is_error: boolean;
}

/** What a redacted entry keeps: the source of the secret pattern it matched, and for a tool call which tool ran. */
export interface RedactedContent {
  redacted: string;
  id?: string;
  name?: string;
}

export type TranscriptContent = TextContent | ToolUseContent | ToolResultContent | RedactedContent;

const text = z.object({ text: z.string() });
const toolUse = z.object({ id: z.string(), name: z.string(), input: z.unknown() });
const toolResult = z.object({ tool_use_id: z.string(), output: z.string(), is_error: z.boolean() });
const pattern = z.string().max(MAX_REDACTED_PATTERN);
const hidden = z.object({ redacted: pattern });
const hiddenToolUse = z.object({ id: z.string(), name: z.string(), redacted: pattern });

function contentFor(role: TranscriptRole, redacted: boolean): { schema: z.ZodType<TranscriptContent>; shape: string } {
  if (redacted) {
    // The fuller shape first: parsed as `hidden`, a redacted tool call would lose which tool it was.
    return role === "tool_use"
      ? { schema: z.union([hiddenToolUse, hidden]), shape: "{id, name, redacted} or {redacted}" }
      : { schema: hidden, shape: "{redacted}" };
  }
  switch (role) {
    case "tool_use":
      return { schema: toolUse, shape: "{id, name, input}" };
    case "tool_result":
      return { schema: toolResult, shape: "{tool_use_id, output, is_error}" };
    default:
      return { schema: text, shape: "{text}" };
  }
}

const messageId = z
  .string()
  .nullish()
  .transform((value, context) => {
    if (value === undefined || value === null) {
      return null;
    }
    const id = messageIdOf(value);
    if (id === undefined) {
      context.addIssue({ code: "custom", message: "must be a message id" });
      return z.NEVER;
    }
    return id;
  });

const entry = z
  .object({
    key: z.string().min(1).max(MAX_ENTRY_KEY).regex(ENTRY_KEY_PATTERN, "must be letters, digits, ':', '_' and '-'"),
    role: z.enum(TRANSCRIPT_ROLES),
    content: z.record(z.unknown()),
    truncated: z.boolean().default(false),
    redacted: z.boolean().default(false),
    message_id: messageId,
    occurred_at: z
      .string()
      .datetime({ offset: true })
      .transform((value) => new Date(value))
  })
  .transform((value, context) => {
    const { schema, shape } = contentFor(value.role, value.redacted);
    const parsed = schema.safeParse(value.content);
    if (!parsed.success) {
      const kind = value.redacted ? `a redacted ${value.role}` : `a ${value.role}`;
      context.addIssue({ code: "custom", path: ["content"], message: `must be ${shape} for ${kind} entry` });
      return z.NEVER;
    }
    if (contentBytes(parsed.data) > MAX_ENTRY_CONTENT_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: `is larger than ${MAX_ENTRY_CONTENT_BYTES} bytes as JSON; truncate it and set truncated`
      });
      return z.NEVER;
    }
    return { ...value, content: parsed.data };
  });

export const transcriptBody = z.object({
  session_id: z.string().trim().min(1).max(MAX_SESSION_ID),
  entries: z.array(entry).min(1).max(MAX_BATCH_ENTRIES, `at most ${MAX_BATCH_ENTRIES} entries per request`)
});

export type NewTranscriptEntry = z.output<typeof entry>;
