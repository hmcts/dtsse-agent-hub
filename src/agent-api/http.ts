import type { ZodTypeAny, z } from "zod";

/** A refusal with the status and JSON body the contract gives it: `{"error": "<message>"}` plus any extras. */
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function errorResponse(status: number, message: string, extra: Record<string, unknown> = {}, headers?: HeadersInit): Response {
  return Response.json({ ...extra, error: message }, { status, headers });
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** The request body as JSON. An empty body reads as `{}`, so a body-less POST is not a parse error. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the request body is not valid JSON");
  }
}

/** Parses against a schema, turning the first issue into a 400 that names the field. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const field = issue?.path.join(".") ?? "";
  throw new HttpError(400, field === "" ? (issue?.message ?? "invalid request") : `${field}: ${issue?.message}`);
}

const DIGITS = /^\d{1,19}$/;

/** A message id from a path or query: a non-negative bigint written in decimal. */
export function parseMessageId(value: string | null | undefined, name = "id"): bigint {
  if (value === null || value === undefined || !DIGITS.test(value)) {
    throw new HttpError(400, `${name} must be a message id`);
  }
  const id = BigInt(value);
  if (id > 9_223_372_036_854_775_807n) {
    throw new HttpError(400, `${name} is out of range`);
  }
  return id;
}

/** `?limit=`, defaulting when absent and refusing anything that is not a whole number in range. */
export function parseLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null || value === "") {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, "limit must be a whole number");
  }
  const limit = Number(value);
  if (limit < 1 || limit > maximum) {
    throw new HttpError(400, `limit must be between 1 and ${maximum}`);
  }
  return limit;
}
