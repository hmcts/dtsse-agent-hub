/**
 * The orchestrator's environment, read once at startup. Every problem is reported together, so a misconfigured
 * deployment says everything that is wrong with it in its first log line rather than one variable per restart.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_HUB_URL = "https://agent-hub.aat.platform.hmcts.net";
export const DEFAULT_HUB_AUDIENCE = "api://dtsse-agent-hub";
export const DEFAULT_SERVICE_ACCOUNT = "virtual-agent";
export const DEFAULT_DISK_SIZE = "32Gi";
export const DEFAULT_INTERVAL_SECONDS = 10;
export const DEFAULT_PORT = 8080;
/** Passes between orphan sweeps: at the default interval, every five minutes. */
export const ORPHAN_SWEEP_EVERY = 30;

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
const DIGEST_PINNED = /^[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]+)+(?::\w[\w.-]{0,127})?@sha256:[a-f0-9]{64}$/;
const QUANTITY = /^[1-9]\d*(Mi|Gi|Ti)$/;
const DNS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
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
  check(image === undefined || DIGEST_PINNED.test(image), "VIRTUAL_AGENT_IMAGE must be pinned by digest: <registry>/<repository>@sha256:<64 hex digits>");

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
  check(DNS_NAME.test(serviceAccount), "VIRTUAL_AGENT_SERVICE_ACCOUNT must be a Kubernetes object name");

  const diskSize = text(env, "VIRTUAL_AGENT_DISK_SIZE") ?? DEFAULT_DISK_SIZE;
  check(QUANTITY.test(diskSize), "VIRTUAL_AGENT_DISK_SIZE must be a size in Mi, Gi or Ti, as 32Gi");

  const storageClass = text(env, "VIRTUAL_AGENT_STORAGE_CLASS") ?? null;
  check(storageClass === null || DNS_NAME.test(storageClass), "VIRTUAL_AGENT_STORAGE_CLASS must be a Kubernetes object name");

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
    hubScope: `${audience.replace(/\/+$/, "")}/.default`,
    intervalMs: intervalSeconds * 1000,
    orphanSweepEvery: ORPHAN_SWEEP_EVERY,
    port,
    agent: { namespace: ns!, image: image!, serviceAccount, hubUrl: agentHubUrl, tenantId: tenantId!, diskSize, storageClass }
  };
}
