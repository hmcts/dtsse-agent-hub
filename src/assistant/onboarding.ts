import type { CredentialKind } from "../credentials/names.ts";
import type { VirtualAgentStatus } from "../virtual-agents/lifecycle.ts";

/**
 * How far the person's assistant has got, as the getting-ready screen shows it: a bar, a line of plain words, and
 * whether they still have something to connect. Someone with every needed credential stored has onboarded, and is
 * not taken through the connections again; they wait on the warming-up screen whenever they arrive to an assistant
 * that is not running, and are asked only for a sign-in its pod has stopped to ask them for.
 */

export interface Readiness {
  /** 0 to 100. */
  percent: number;
  step: string;
  ready: boolean;
  failed: boolean;
}

const STEPS: Readonly<Record<VirtualAgentStatus, { percent: number; step: string }>> = {
  requested: { percent: 10, step: "Starting your assistant…" },
  provisioning: { percent: 30, step: "Starting your assistant…" },
  awaiting_credentials: { percent: 55, step: "Waiting for you to connect your accounts…" },
  awaiting_login: { percent: 55, step: "Waiting for you to connect your accounts…" },
  cloning: { percent: 80, step: "Preparing your workspace…" },
  running: { percent: 100, step: "Your assistant is ready" },
  stopping: { percent: 5, step: "Starting your assistant again…" },
  stopped: { percent: 5, step: "Starting your assistant again…" },
  failed: { percent: 0, step: "Your assistant could not start" }
};

export function readiness(status: VirtualAgentStatus): Readiness {
  const step = STEPS[status];
  return { ...step, ready: status === "running", failed: status === "failed" };
}

/** Whether the person has stored every credential their assistant needs, which is what onboarding is. */
export function onboarded(needed: readonly CredentialKind[], stored: ReadonlySet<CredentialKind>): boolean {
  return needed.every((kind) => stored.has(kind));
}

/**
 * The credentials without which there is no chat to be had: GitHub, and the key to the assistant's model. Which key
 * that is follows the assistant's route, as `neededCredentials` decides it — a Claude token on the person's own
 * licence, a Bedrock API key on Amazon Bedrock — so "Claude connected" means the key its pod will use, never
 * whichever of the two happens to be stored. A key for the other route is no use to the pod.
 *
 * Azure is needed too but is not here: the banner asks for it, and a chat is still worth having without it.
 */
const CHAT_CREDENTIALS: readonly CredentialKind[] = ["github", "claude", "bedrock"];

export function chatCredentials(needed: readonly CredentialKind[]): CredentialKind[] {
  return needed.filter((kind) => CHAT_CREDENTIALS.includes(kind));
}

/**
 * Whether the person may reach the chat: `blocked` while one of `chatCredentials` is not stored, `open` otherwise.
 *
 * Credentials the hub cannot read leave it `open`, for the reason `connectionsAsk` gives: `stored` is empty then
 * whatever the person has connected, so a gate on it would hold someone who has signed in everywhere behind a screen
 * nothing they do can satisfy. `credentialBackend` answers unavailable only for a deployment that keeps no
 * credentials at all — a preview, sign-in turned off, a malformed vault URL — where nobody can connect anything and
 * the pod has nothing to boot on either, so a gate there would shut everybody out and protect nothing.
 */
export type ChatGate = "open" | "blocked";

export function chatGate(toChat: readonly CredentialKind[], stored: ReadonlySet<CredentialKind>, unavailable: string | null): ChatGate {
  if (unavailable !== null) {
    return "open";
  }
  return toChat.every((kind) => stored.has(kind)) ? "open" : "blocked";
}

/** What a server action answers while the gate is `blocked`, for a page that was loaded before it closed. */
export const CHAT_BLOCKED = "connect GitHub and Claude before you start chatting";

/**
 * What the getting-ready screen asks of the person: to connect their accounts, nothing because they have, or
 * nothing because the hub cannot tell.
 *
 * `onboarded` alone cannot say which of the last two it is. It is built from the credentials the hub managed to
 * read, so it is false both for someone who has connected nothing and for someone whose stored sign-ins the hub
 * could not see — and `unavailable` is the only thing that tells the two apart. Reading the second as the first
 * walks a person who has signed in everywhere back through connections they already made, and holds them behind a
 * button they can never satisfy, so it is the mistake worth going out of the way to avoid.
 */
export type ConnectionsAsk = "connect" | "done" | "unknown";

export function connectionsAsk(onboarded: boolean, unavailable: string | null): ConnectionsAsk {
  if (unavailable !== null) {
    return "unknown";
  }
  return onboarded ? "done" : "connect";
}
