import { isIP } from "node:net";
import { DEFAULT_PUBLIC_DOMAIN } from "../virtual-agents/ports.ts";

/**
 * The orchestrator's environment, read once at startup. Every problem is reported together, so a misconfigured
 * deployment says everything that is wrong with it in its first log line rather than one variable per restart.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_HUB_URL = "https://agent-hub.aat.platform.hmcts.net";
export const DEFAULT_HUB_AUDIENCE = "api://dtsse-agent-hub";
/** The namespace's own: the pods mount no token and have no workload identity, so they need no account of their own. */
export const DEFAULT_SERVICE_ACCOUNT = "default";
export const DEFAULT_DISK_SIZE = "32Gi";
export const DEFAULT_INTERVAL_SECONDS = 10;
export const DEFAULT_PORT = 8080;
/** Passes between orphan sweeps: at the default interval, every five minutes. */
export const ORPHAN_SWEEP_EVERY = 30;

export interface HostAlias {
  ip: string;
  hostnames: string[];
}

/** What each virtual agent's StatefulSet is built from. */
export interface VirtualAgentSpec {
  namespace: string;
  /** Digest-pinned, so a pod that restarts runs the image it was created with. */
  image: string;
  serviceAccount: string;
  hubUrl: string;
  tenantId: string;
  diskSize: string;
  /** `null` for the cluster's default storage class. */
  storageClass: string | null;
  /** Extra `/etc/hosts` entries for the pod, grouped by address. */
  hostAliases: HostAlias[];
  /** Each reported port's Ingress host is `<statefulset>-<port>.<publicDomain>`, and the pod is given it to work its URLs out. */
  publicDomain: string;
}

export interface OrchestratorSettings {
  cluster: string;
  namespace: string;
  hubUrl: string;
  /** The scope the orchestrator's token is asked for: the hub's Application ID URI and `/.default`. */
  hubScope: string;
  intervalMs: number;
  orphanSweepEvery: number;
  port: number;
  agent: VirtualAgentSpec;
}

export class OrchestratorConfigurationError extends Error {}

const CLUSTER = /^[A-Za-z0-9._-]{1,100}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE_NAME = /^[a-z0-9][a-z0-9._:/-]{0,254}$/;
const DNS_LABEL = /^[a-z0-9-]{1,63}$/;
const QUANTITY = /^[1-9]\d*(Mi|Gi|Ti)$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<registry>/<repository>[:tag]@sha256:<64 hex digits>`, checked in parts so no pattern has to backtrack. */
function digestPinned(image: string): boolean {
  const [name, digest, extra] = image.split("@");
  return extra === undefined && name !== undefined && digest !== undefined && name.includes("/") && IMAGE_NAME.test(name) && DIGEST.test(digest);
}

/** A Kubernetes object name: dot-separated labels of lowercase letters, digits and inner hyphens. */
function dnsName(value: string): boolean {
  return value.length <= 253 && value.split(".").every((label) => DNS_LABEL.test(label) && !label.startsWith("-") && !label.endsWith("-"));
}

/**
 * `VIRTUAL_AGENT_HOST_ALIASES`: comma-separated `host=ip` pairs, for hosts whose public DNS answer the pod cannot use,
 * as `build.hmcts.net`, which resolves to an Entra application proxy that needs an interactive sign-in while its
 * private address answers from the preview cluster. Every bad pair is reported, as for the other settings.
 */
export function parseHostAliases(raw: string | undefined): { aliases: HostAlias[]; problems: string[] } {
  const problems: string[] = [];
  const byIp = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const pair = entry.trim();
    if (pair === "") {
      continue;
    }
    const [host, ip, extra] = pair.split("=").map((part) => part.trim());
    // `split` always gives at least one part.
    const hostname = host!.toLowerCase();
    if (extra !== undefined || ip === undefined || hostname === "" || !dnsName(hostname) || isIP(ip) === 0) {
      problems.push(`VIRTUAL_AGENT_HOST_ALIASES has "${pair}", which is not host=ip with a DNS name and an IP address`);
      continue;
    }
    if (seen.has(hostname)) {
      problems.push(`VIRTUAL_AGENT_HOST_ALIASES names ${hostname} more than once`);
      continue;
    }
    seen.add(hostname);
    byIp.set(ip, [...(byIp.get(ip) ?? []), hostname]);
  }
  return { aliases: [...byIp].map(([ip, hostnames]) => ({ ip, hostnames })), problems };
}

function text(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function httpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * `namespace` is the in-cluster ServiceAccount's namespace file, or `undefined` when there is none: the orchestrator
 * manages only the namespace it runs in.
 */
export function orchestratorSettings(env: Environment, namespace: string | undefined): OrchestratorSettings {
  const problems: string[] = [];
  const check = (ok: boolean, problem: string): void => {
    if (!ok) {
      problems.push(problem);
    }
  };
  const whole = (name: string, fallback: number, max: number): number => {
    const raw = text(env, name);
    if (raw === undefined) {
      return fallback;
    }
    check(/^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= max, `${name} must be a whole number from 1 to ${max}`);
    return Number(raw);
  };

  const image = text(env, "VIRTUAL_AGENT_IMAGE");
  check(image !== undefined, "VIRTUAL_AGENT_IMAGE is not set");
  check(image === undefined || digestPinned(image), "VIRTUAL_AGENT_IMAGE must be pinned by digest: <registry>/<repository>@sha256:<64 hex digits>");

  const cluster = text(env, "ORCHESTRATOR_CLUSTER");
  check(cluster !== undefined, "ORCHESTRATOR_CLUSTER is not set: name the cluster this runs in, as cft-preview-00");
  check(cluster === undefined || CLUSTER.test(cluster), "ORCHESTRATOR_CLUSTER must be 1–100 letters, digits, dots, hyphens or underscores");

  const ns = namespace?.trim() || undefined;
  check(ns !== undefined, "no namespace: the orchestrator runs in a Kubernetes pod with a ServiceAccount token mounted");

  const tenantId = text(env, "AZURE_TENANT_ID");
  check(tenantId !== undefined && GUID.test(tenantId), "AZURE_TENANT_ID must be the Entra tenant id; workload identity sets it");
  const federated = text(env, "AZURE_CLIENT_ID") !== undefined && text(env, "AZURE_FEDERATED_TOKEN_FILE") !== undefined;
  check(
    federated,
    "AZURE_CLIENT_ID and AZURE_FEDERATED_TOKEN_FILE are not set: the pod needs workload identity, as its ServiceAccount's client-id annotation and the pod's azure.workload.identity/use label"
  );

  const hubUrl = text(env, "AGENT_HUB_URL") ?? DEFAULT_HUB_URL;
  check(httpUrl(hubUrl), "AGENT_HUB_URL must be an http or https URL");
  const agentHubUrl = text(env, "VIRTUAL_AGENT_HUB_URL") ?? hubUrl;
  check(httpUrl(agentHubUrl), "VIRTUAL_AGENT_HUB_URL must be an http or https URL");

  const serviceAccount = text(env, "VIRTUAL_AGENT_SERVICE_ACCOUNT") ?? DEFAULT_SERVICE_ACCOUNT;
  check(dnsName(serviceAccount), "VIRTUAL_AGENT_SERVICE_ACCOUNT must be a Kubernetes object name");

  const diskSize = text(env, "VIRTUAL_AGENT_DISK_SIZE") ?? DEFAULT_DISK_SIZE;
  check(QUANTITY.test(diskSize), "VIRTUAL_AGENT_DISK_SIZE must be a size in Mi, Gi or Ti, as 32Gi");

  const storageClass = text(env, "VIRTUAL_AGENT_STORAGE_CLASS") ?? null;
  check(storageClass === null || dnsName(storageClass), "VIRTUAL_AGENT_STORAGE_CLASS must be a Kubernetes object name");

  const hostAliases = parseHostAliases(env.VIRTUAL_AGENT_HOST_ALIASES);
  problems.push(...hostAliases.problems);

  const publicDomain = text(env, "VIRTUAL_AGENT_PUBLIC_DOMAIN")?.toLowerCase() ?? DEFAULT_PUBLIC_DOMAIN;
  check(dnsName(publicDomain), "VIRTUAL_AGENT_PUBLIC_DOMAIN must be a DNS name, as preview.platform.hmcts.net");

  const audience = text(env, "AGENT_HUB_AUDIENCE") ?? DEFAULT_HUB_AUDIENCE;
  const intervalSeconds = whole("ORCHESTRATOR_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS, 3600);
  const port = whole("ORCHESTRATOR_PORT", DEFAULT_PORT, 65535);

  if (problems.length > 0) {
    throw new OrchestratorConfigurationError(`the orchestrator cannot start: ${problems.join("; ")}`);
  }
  return {
    cluster: cluster!,
    namespace: ns!,
    hubUrl,
    hubScope: `${withoutTrailingSlashes(audience)}/.default`,
    intervalMs: intervalSeconds * 1000,
    orphanSweepEvery: ORPHAN_SWEEP_EVERY,
    port,
    agent: {
      namespace: ns!,
      image: image!,
      serviceAccount,
      hubUrl: agentHubUrl,
      tenantId: tenantId!,
      diskSize,
      storageClass,
      hostAliases: hostAliases.aliases,
      publicDomain
    }
  };
}

export function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}
