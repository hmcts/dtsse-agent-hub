/**
 * The web ports a virtual agent's owner exposes, each served at its own host under the preview cluster's public
 * domain, where the cluster's external-dns makes a record for every Ingress host.
 */

export const MAX_EXPOSED_PORTS = 3;

/** Below 1024 a port needs root, which the pod never has. */
export const MIN_EXPOSED_PORT = 1024;
export const MAX_EXPOSED_PORT = 65535;

export const DEFAULT_PUBLIC_DOMAIN = "preview.platform.hmcts.net";

export type CheckedPort = { ok: true; port: number } | { ok: false; error: string };

export function checkPort(raw: unknown): CheckedPort {
  const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!/^\d{1,5}$/.test(value) || Number(value) < MIN_EXPOSED_PORT || Number(value) > MAX_EXPOSED_PORT) {
    return { ok: false, error: `a port is a whole number from ${MIN_EXPOSED_PORT} to ${MAX_EXPOSED_PORT}` };
  }
  return { ok: true, port: Number(value) };
}

/** Why `port` cannot be added to `existing`, or `undefined` when it can. */
export function exposeRefusal(existing: readonly number[], port: number): string | undefined {
  if (existing.includes(port)) {
    return `port ${port} is already exposed`;
  }
  if (existing.length >= MAX_EXPOSED_PORTS) {
    return `a virtual agent can expose at most ${MAX_EXPOSED_PORTS} ports; remove one first`;
  }
  return undefined;
}

/** Ascending, so the list reads the same however the ports were added. */
export function withPort(existing: readonly number[], port: number): number[] {
  return [...existing, port].sort((left, right) => left - right);
}

export function withoutPort(existing: readonly number[], port: number): number[] {
  return existing.filter((candidate) => candidate !== port);
}

/** `<statefulset>-<port>.<domain>`, one label under the domain. */
export function publicHost(statefulsetName: string, port: number, domain: string): string {
  return `${statefulsetName}-${port}.${domain}`;
}

export function publicUrl(statefulsetName: string, port: number, domain: string): string {
  return `https://${publicHost(statefulsetName, port, domain)}`;
}
