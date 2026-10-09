import { publicHost } from "../virtual-agents/ports.ts";
import { DEFAULT_SIZE, isVirtualAgentSize, SIZE_RESOURCES } from "../virtual-agents/size.ts";
import type { ClaimedAgent } from "./hub.ts";
import type { Ingress, Service, StatefulSet } from "./kube.ts";
import type { VirtualAgentSpec } from "./settings.ts";

/**
 * What the orchestrator applies for each virtual agent: a StatefulSet, and a Service and an Ingress while its pod
 * reports web ports. The preview cluster's Gatekeeper refuses a pod no controller owns; the launch token is in the pod
 * template rather than a Secret, and the disk is the claim template's, deleted with the StatefulSet, so the
 * orchestrator needs no access to Secrets or PVCs.
 */

export const MANAGED_BY = "agent-hub-orchestrator";
export const MANAGED_SELECTOR = `app.kubernetes.io/managed-by=${MANAGED_BY}`;
export const ID_LABEL = "agent-hub.hmcts.net/virtual-agent-id";
export const GENERATION_ANNOTATION = "agent-hub.hmcts.net/generation";
export const LAUNCH_TOKEN_ENV = "AGENT_HUB_LAUNCH_TOKEN";

const CONTAINER = "agent";
const CLAIM_TEMPLATE = "work";
const HOME = "/home/hmcts";
const UID = 1000;

export function podName(statefulsetName: string): string {
  return `${statefulsetName}-0`;
}

export function labels(id: string): Record<string, string> {
  return { "app.kubernetes.io/name": "virtual-agent", "app.kubernetes.io/managed-by": MANAGED_BY, [ID_LABEL]: id };
}

/** A StatefulSet's claim template cannot change once created, so an existing agent keeps the disk it was made with. */
export interface Disk {
  size: string;
  storageClass: string | null;
}

/** What an existing StatefulSet carries over to the next apply of it. */
export interface Carried {
  disk?: Disk;
  launchToken?: string;
}

interface EnvVar {
  name: string;
  value?: unknown;
}

interface Shape {
  volumeClaimTemplates?: { spec?: { resources?: { requests?: { storage?: unknown } }; storageClassName?: unknown } }[];
  replicas?: unknown;
  template?: { metadata?: { annotations?: Record<string, unknown> }; spec?: { containers?: { name?: unknown; env?: EnvVar[] }[] } };
}

function shapeOf(existing: StatefulSet | null): Shape {
  return (existing?.spec ?? {}) as Shape;
}

function diskOf(shape: Shape): Disk | undefined {
  const template = Array.isArray(shape.volumeClaimTemplates) ? shape.volumeClaimTemplates[0] : undefined;
  const size = template?.spec?.resources?.requests?.storage;
  if (typeof size !== "string") {
    return undefined;
  }
  const storageClass = template?.spec?.storageClassName;
  return { size, storageClass: typeof storageClass === "string" ? storageClass : null };
}

function launchTokenOf(shape: Shape): string | undefined {
  const containers = shape.template?.spec?.containers;
  const container = Array.isArray(containers) ? containers.find((candidate) => candidate.name === CONTAINER) : undefined;
  const value = (Array.isArray(container?.env) ? container.env : []).find((entry) => entry.name === LAUNCH_TOKEN_ENV)?.value;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The disk an existing StatefulSet was created with, and the launch token its pod was given, so that an apply with
 * no new token keeps the one the running pod holds.
 */
export function carriedOver(existing: StatefulSet | null): Carried {
  const shape = shapeOf(existing);
  const disk = diskOf(shape);
  const launchToken = launchTokenOf(shape);
  return { ...(disk === undefined ? {} : { disk }), ...(launchToken === undefined ? {} : { launchToken }) };
}

export function plugins(agent: Pick<ClaimedAgent, "plugins">): string[] {
  return Array.isArray(agent.plugins) ? agent.plugins : [];
}

/**
 * The pod is given its public domain rather than its URLs, so that a server starting or stopping changes the Service
 * and Ingress and never the pod template. Its plugins are in the template, empty for none, so a change of them rolls
 * the pod, as the `pod_generation` bump that comes with it asks.
 */
function env(agent: ClaimedAgent, spec: VirtualAgentSpec, launchToken: string) {
  return [
    { name: "AGENT_HUB_URL", value: spec.hubUrl },
    { name: "AGENT_HUB_VIRTUAL", value: "1" },
    { name: "AGENT_HUB_VIRTUAL_AGENT_ID", value: agent.id },
    { name: "AGENT_HUB_MODEL_ROUTE", value: agent.model_route },
    { name: "AGENT_HUB_PLUGINS", value: plugins(agent).join(",") },
    { name: "AZURE_TENANT_ID", value: spec.tenantId },
    { name: "DISABLE_AUTOUPDATER", value: "1" },
    { name: "KNOWLEDGE_SWEEP_CHILD", value: "1" },
    { name: "VIRTUAL_AGENT_PUBLIC_DOMAIN", value: spec.publicDomain },
    { name: LAUNCH_TOKEN_ENV, value: launchToken }
  ];
}

/**
 * The CPU and memory of the agent's size, and the same scratch space for every size. Built afresh on every apply, so
 * a StatefulSet made before a size change gets the new resources the next time it is applied.
 */
export function resources(agent: Pick<ClaimedAgent, "size">) {
  const size = SIZE_RESOURCES[isVirtualAgentSize(agent.size) ? agent.size : DEFAULT_SIZE];
  return {
    requests: { ...size.requests, "ephemeral-storage": "2Gi" },
    limits: { ...size.limits, "ephemeral-storage": "10Gi" }
  };
}

/**
 * The pod template carries the claim's pod generation, so starting an agent again replaces a pod that is still there
 * with one holding the newly minted launch token. The hub moves it for everything but a change of ports.
 *
 * The claim template's PVC is deleted with the StatefulSet and kept when it scales to zero, so stopping keeps the
 * disk, deleting the StatefulSet deletes it, and starting after that makes a fresh one.
 */
export function statefulSet(agent: ClaimedAgent, spec: VirtualAgentSpec, launchToken: string, carried?: Carried): StatefulSet {
  const name = agent.statefulset_name;
  const tagged = labels(agent.id);
  const disk = carried?.disk ?? { size: spec.diskSize, storageClass: spec.storageClass };
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name, namespace: spec.namespace, labels: tagged },
    spec: {
      replicas: agent.desired === "running" ? 1 : 0,
      serviceName: name,
      selector: { matchLabels: { [ID_LABEL]: agent.id } },
      persistentVolumeClaimRetentionPolicy: { whenDeleted: "Delete", whenScaled: "Retain" },
      template: {
        metadata: { labels: tagged, annotations: { [GENERATION_ANNOTATION]: String(podGeneration(agent)) } },
        spec: {
          serviceAccountName: spec.serviceAccount,
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 60,
          ...(spec.hostAliases.length === 0 ? {} : { hostAliases: spec.hostAliases }),
          securityContext: {
            runAsUser: UID,
            runAsGroup: UID,
            fsGroup: UID,
            runAsNonRoot: true,
            seccompProfile: { type: "RuntimeDefault" }
          },
          containers: [
            {
              name: CONTAINER,
              image: spec.image,
              command: ["virtual-agent-boot"],
              env: env(agent, spec, launchToken),
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              resources: resources(agent),
              volumeMounts: [
                { name: CLAIM_TEMPLATE, mountPath: "/workspace", subPath: "workspace" },
                { name: CLAIM_TEMPLATE, mountPath: `${HOME}/.claude`, subPath: "claude" },
                { name: "azure", mountPath: `${HOME}/.azure` },
                { name: "gh", mountPath: `${HOME}/.config/gh` }
              ]
            }
          ],
          volumes: [
            { name: "azure", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
            { name: "gh", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } }
          ]
        }
      },
      volumeClaimTemplates: [
        {
          metadata: { name: CLAIM_TEMPLATE, labels: tagged },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: disk.size } },
            ...(disk.storageClass === null ? {} : { storageClassName: disk.storageClass })
          }
        }
      ]
    }
  };
}

export function podGeneration(agent: Pick<ClaimedAgent, "generation" | "pod_generation">): number {
  return typeof agent.pod_generation === "number" ? agent.pod_generation : agent.generation;
}

/**
 * Whether the StatefulSet already runs the pod the claim asks for: one replica, stamped with the claim's pod
 * generation. Applying it again would put the orchestrator's current image and settings on the template, so a claim
 * for a change of ports alone would restart the pod.
 */
export function runsPodOf(existing: StatefulSet | null, agent: Pick<ClaimedAgent, "generation" | "pod_generation">): boolean {
  const shape = shapeOf(existing);
  return existing !== null && shape.replicas === 1 && shape.template?.metadata?.annotations?.[GENERATION_ANNOTATION] === String(podGeneration(agent));
}

export function exposedPorts(agent: Pick<ClaimedAgent, "exposed_ports">): number[] {
  return Array.isArray(agent.exposed_ports) ? agent.exposed_ports : [];
}

function portName(port: number): string {
  return `p-${port}`;
}

/**
 * A Service in front of the agent's pod with each port it reports, named and labelled as the StatefulSet, so the
 * orchestrator only ever changes or deletes its own, and selecting the pod by the agent's id alone.
 */
export function service(agent: ClaimedAgent, spec: VirtualAgentSpec): Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: agent.statefulset_name, namespace: spec.namespace, labels: labels(agent.id) },
    spec: {
      type: "ClusterIP",
      selector: { [ID_LABEL]: agent.id },
      ports: exposedPorts(agent).map((port) => ({ name: portName(port), port, targetPort: port, protocol: "TCP" }))
    }
  };
}

/** One host per reported port, through Traefik with TLS, each to the Service on that port. */
export function ingress(agent: ClaimedAgent, spec: VirtualAgentSpec): Ingress {
  const name = agent.statefulset_name;
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name, namespace: spec.namespace, labels: labels(agent.id), annotations: { "traefik.ingress.kubernetes.io/router.tls": "true" } },
    spec: {
      ingressClassName: "traefik",
      rules: exposedPorts(agent).map((port) => ({
        host: publicHost(name, port, spec.publicDomain),
        http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name, port: { number: port } } } }] }
      }))
    }
  };
}
