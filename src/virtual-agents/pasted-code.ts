import { hkdfSync } from "node:crypto";
import { openValue, type SealedValue, sealValue } from "../credentials/local.ts";

/**
 * A login code the owner pastes into the UI for their pod to fetch, such as the one `claude setup-token` asks for.
 * It has to wait in the database, since the pod's request may reach a different hub pod, so it is sealed with the
 * same AES-256-GCM scheme as the local credential store, under a key of its own derived from `SESSION_SECRET`, and
 * bound to its virtual agent and kind as additional data so a ciphertext copied onto another row does not open.
 */

const KEY_INFO = "dtsse-agent-hub pasted login code";

/** The longest code accepted. `claude setup-token` asks for one of about a hundred characters. */
export const MAX_PASTED_CODE_LENGTH = 2048;

export function pastedCodeKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", KEY_INFO, 32));
}

function boundTo(virtualAgentId: string, kind: string): string {
  return `${virtualAgentId}:${kind}`;
}

export function sealPastedCode(secret: string, virtualAgentId: string, kind: string, code: string): SealedValue {
  return sealValue(pastedCodeKey(secret), boundTo(virtualAgentId, kind), code);
}

/** Throws when the secret, the agent, the kind or any byte differs from what sealed it. */
export function openPastedCode(secret: string, virtualAgentId: string, kind: string, sealed: SealedValue): string {
  return openValue(pastedCodeKey(secret), boundTo(virtualAgentId, kind), sealed);
}
