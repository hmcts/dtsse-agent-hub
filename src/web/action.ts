import { AccessDenied } from "../access/load.ts";
import { HttpError } from "../agent-api/http.ts";
import { InvalidTopics } from "../topics/slug.ts";
import { NotSignedIn } from "../viewer/identity.ts";

/**
 * What every server action returns: the result, or a sentence to show the person. Actions never throw at the
 * browser, because a thrown error reaches it as an opaque digest.
 */
export type ActionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

/** A refusal the person can act on, or `undefined` for a fault that belongs in the log instead. */
export function refusalMessage(error: unknown): string | undefined {
  if (error instanceof HttpError || error instanceof InvalidTopics || error instanceof AccessDenied) {
    return error.message;
  }
  if (error instanceof NotSignedIn) {
    return "your session has ended; reload the page to sign in again";
  }
  return undefined;
}

export async function runAction<T extends object>(name: string, work: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await work();
  } catch (error) {
    const message = refusalMessage(error);
    if (message !== undefined) {
      return { ok: false, error: message };
    }
    console.error(`the ${name} action failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return { ok: false, error: "something went wrong on our side; try again" };
  }
}

/** One form or argument value as a trimmed string; anything else, such as an uploaded file, reads as empty. */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
