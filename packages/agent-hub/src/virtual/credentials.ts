// The credential store as a pod sees it. A virtual agent reads and writes its owner's credentials through the
// `/api/virtual/{id}/credentials/{kind}` routes, which its launch token may use for its own agent alone.
import fs from "node:fs";
import type { Api, CredentialKind } from "../api.ts";
import { CREDENTIAL_KINDS } from "../api.ts";
import { withRetry } from "../retry.ts";
import { EXIT_NO_CREDENTIAL } from "./phases.ts";

/** The kinds agent-hub gives back to their owner, not only to the owner's virtual agents. */
export const OWNER_READABLE: readonly CredentialKind[] = ["claude_md", "git_identity"];

// `Array.prototype.includes` does not narrow, so a kind read off argv reaches `Api`, whose credential calls
// take the union rather than a string, only through a type predicate.
export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === "string" && (CREDENTIAL_KINDS as readonly string[]).includes(value);
}

export function requireCredentialKind(value: unknown): CredentialKind {
  if (!isCredentialKind(value)) {
    throw new Error(`credential kind must be one of ${CREDENTIAL_KINDS.join(", ")}`);
  }
  return value;
}

/** stdin as one string; an unreadable stdin is the same as an empty one, which the caller refuses. */
export function readStdinText(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export type CredentialStore = Pick<Api, "getCredential" | "putCredential">;

export type CredentialCommandOptions = {
  api: CredentialStore;
  id: string;
  /** The words after `credential`: an action and a kind. */
  argv: string[];
  stdout: Pick<NodeJS.WriteStream, "write">;
  readStdin?: () => string;
};

/**
 * `agent-hub virtual credential get|put <kind>`. The value goes to stdout exactly as stored, is never logged,
 * and is read back from stdin on a put. Returns the exit code.
 */
export async function runCredentialCommand({ api, id, argv, stdout, readStdin = readStdinText }: CredentialCommandOptions): Promise<number> {
  const [action, kind] = argv;
  // The kind is checked outside the retry: one that is not a kind is a usage error, not something another
  // attempt repairs.
  if (action === "get") {
    const want = requireCredentialKind(kind);
    const value = await withRetry(() => api.getCredential(id, want));
    if (!value) {
      return EXIT_NO_CREDENTIAL;
    }
    stdout.write(value);
    return 0;
  }
  if (action === "put") {
    const value = readStdin().trim();
    if (!value) {
      throw new Error("credential put reads the value from stdin, and it was empty");
    }
    const want = requireCredentialKind(kind);
    await withRetry(() => api.putCredential(id, want, value));
    return 0;
  }
  throw new Error("credential takes get or put");
}
