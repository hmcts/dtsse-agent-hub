// A person's stored credentials, and a pod's, which it reads and writes through its agent's routes.
import { execFile } from "node:child_process";
import { type Api, ApiError } from "../api.ts";
import { withRetry } from "../retry.ts";
import { EXIT_NO_CREDENTIAL, isCredentialKind, OWNER_READABLE } from "../virtual/index.ts";
import { virtualAgent } from "../virtual-agent.ts";
import { CREDENTIAL_KINDS, type CredentialKind } from "../wire.ts";
import { type Cli, type Command, UsageError } from "./command.ts";

function ghToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 30000 }, (err, stdout) => {
      if (err) {
        reject(new Error(err.code === "ENOENT" ? "gh is not installed" : "gh auth token failed; run gh auth login first"));
      } else {
        resolve(stdout);
      }
    });
  });
}

type CredentialAction = "get" | "set" | "delete";

/** A pod, with its agent id; null for a person, who has an identity of their own and uses the person routes. */
type Pod = { id: string } | null;

/** The `credentials` arguments, refused before anything is asked of the hub. */
function credentialArgs(argv: string[]): { action: CredentialAction; kind: CredentialKind; fromGh: boolean } {
  const fromGh = argv.includes("--from-gh");
  const [action, kind, ...extra] = argv.filter((a) => a !== "--from-gh");
  if (action !== "get" && action !== "set" && action !== "delete") {
    throw new UsageError("credentials takes get, set or delete");
  }
  // `Array.prototype.includes` does not narrow, so the kind reaches the hub client only through the predicate.
  if (!isCredentialKind(kind)) {
    throw new UsageError(`credential kind must be one of ${CREDENTIAL_KINDS.join(", ")}`);
  }
  if (extra.length) {
    throw new UsageError(`unexpected argument: ${extra[0]}`);
  }
  if (fromGh && (action !== "set" || kind !== "github")) {
    throw new UsageError("--from-gh only goes with credentials set github");
  }
  // The hub keeps a Microsoft 365 connection to itself: it is made with Connect and never read back or uploaded.
  if (kind === "microsoft" && action !== "delete") {
    throw new UsageError(
      "a Microsoft 365 connection is made with Connect in the Assistant's settings and is never read back; credentials delete microsoft disconnects it"
    );
  }
  return { action, kind, fromGh };
}

async function getCredential(cli: Cli, api: Api, pod: Pod, kind: CredentialKind): Promise<number> {
  if (!pod && !OWNER_READABLE.includes(kind)) {
    throw new UsageError(
      `agent-hub returns only your ${OWNER_READABLE.slice(0, -1).join(", ")} and ${OWNER_READABLE.at(-1)} credentials; the other kinds are read by virtual agents`
    );
  }
  const value = pod ? await withRetry(() => api.getCredential(pod.id, kind)) : await api.myCredential(kind);
  if (!value) {
    return EXIT_NO_CREDENTIAL;
  }
  cli.stdout.write(value);
  return 0;
}

async function setCredential(cli: Cli, api: Api, pod: Pod, kind: CredentialKind, fromGh: boolean): Promise<number> {
  const raw = fromGh ? await ghToken() : cli.readStdin();
  // A CLAUDE.md is text whose layout matters, so it is stored as written.
  const value = kind === "claude_md" ? raw : raw.trim();
  if (!value.trim()) {
    throw new UsageError(
      fromGh ? "gh auth token printed nothing; run gh auth login first" : `credentials set reads the ${kind} value from stdin, and it was empty`
    );
  }
  if (pod) {
    await withRetry(() => api.putCredential(pod.id, kind, value));
  } else {
    await api.putMyCredential(kind, value);
  }
  cli.printError(`agent-hub: ${kind} credential stored`);
  return 0;
}

async function deleteCredential(cli: Cli, api: Api, pod: Pod, kind: CredentialKind): Promise<number> {
  if (pod) {
    throw new UsageError("a virtual agent cannot delete its credentials; its owner removes them in the CFT Workspace's settings");
  }
  try {
    await api.deleteMyCredential(kind);
    cli.printError(`agent-hub: ${kind} credential deleted`);
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) {
      throw e;
    }
    cli.printError(`agent-hub: no ${kind} credential was stored`);
  }
  return 0;
}

export const credentials: Command = (cli, argv) => {
  const { action, kind, fromGh } = credentialArgs(argv);
  const api = cli.api();
  // A pod has no person identity, only its launch token, so it uses its agent's routes.
  const pod = virtualAgent(cli.env);
  if (action === "get") {
    return getCredential(cli, api, pod, kind);
  }
  if (action === "set") {
    return setCredential(cli, api, pod, kind, fromGh);
  }
  return deleteCredential(cli, api, pod, kind);
};
