/**
 * The web ports a virtual agent's pod reports listening on, each served at its own host under the preview cluster's
 * public domain, where the cluster's external-dns makes a record for every Ingress host.
 */

export const MAX_REPORTED_PORTS = 10;

/** Below 1024 a port needs root, which the pod never has. */
export const MIN_EXPOSED_PORT = 1024;
export const MAX_EXPOSED_PORT = 65535;

export const DEFAULT_PUBLIC_DOMAIN = "preview.platform.hmcts.net";

/** Ascending and without repeats, so equal sets compare equal however the pod listed them. */
export function normalisePorts(ports: readonly number[]): number[] {
  return [...new Set(ports)].sort((left, right) => left - right);
}

export function samePorts(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((port, index) => port === right[index]);
}

/** `<statefulset>-<port>.<domain>`, one label under the domain. */
export function publicHost(statefulsetName: string, port: number, domain: string): string {
  return `${statefulsetName}-${port}.${domain}`;
}

export function publicUrl(statefulsetName: string, port: number, domain: string): string {
  return `https://${publicHost(statefulsetName, port, domain)}`;
}
