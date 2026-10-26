import { publicHost } from "../virtual-agents/ports.ts";
import { DEFAULT_SIZE, isVirtualAgentSize, SIZE_RESOURCES, type VirtualAgentSize } from "../virtual-agents/size.ts";
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
 * How many HMCTS Assistant conversation sessions a pod runs at once beside its own, by size.
 *
 * **A session costs about 0.65Gi of anonymous memory, and bursts past four CPUs on its own.** The memory figure is
 * the drop in the container cgroup's `memory.stat` `anon` when a preview pod went from two sessions to one — 0.64Gi,
 * against 0.68Gi for the same subtraction of every process's proportional set size from
 * `/proc/<pid>/smaps_rollup`. Each session is a `claude` process with its own MCP servers, hai wrapper and bridge;
 * the MCP servers and their wrappers are about half of it.
 *
 * **That marginal is one transition of one `small` pod, n=1**, and the two routes agreeing are the same subtraction
 * read two ways rather than two measurements. The 0.95Gi baseline below is the part with a sample behind it: 15,
 * across two pods and two images, spread 0.91–0.99Gi. Every pod in preview is `small`, so nothing here is measured
 * on the sizes it is applied to.
 *
 * **Measure this in PSS, never RSS.** A session is twenty-odd node processes sharing one node binary and their
 * `node_modules` pages, so ΣRSS counts those pages once per process and puts the same marginal at 1.25Gi, nearly
 * double. What the processes share is those binary and library pages and not their heaps, which is why a session's
 * PSS sits only a sixth above the pages that are wholly its own.
 *
 * The cap is reasoned about in `anon`, because that is the part the kernel cannot reclaim. Page cache was 2.1–2.4Gi
 * on the pods measured — the 6.8GiB workspace clone rather than the sessions — and is evicted under pressure rather
 * than killing the container.
 *
 * **Both constraints are read against the size's requests, not its limits.** An awake pod with no conversations holds
 * about 0.95Gi of `anon` — its own session, the three agent-hub daemons and the entrypoint — so a cap of N costs
 * 0.95 + 0.65N Gi, and a pod over its memory request is an eviction candidate when the node comes under pressure,
 * whatever headroom its limit leaves. **Memory is the only hard constraint.** CPU has no limit at all
 * (`SIZE_RESOURCES` says why), so a pod over its CPU request is not in breach of anything — the request is a floor
 * its bursts borrow above, not a ceiling — and keeping a cap's sustained draw inside it, (N + 1) × 186m on the
 * 139–186m working mean with the pod's own session counted, is a convention this chooses rather than a rule the
 * cluster imposes. It is worth keeping as a sanity check on whether a pod would be contending with its own
 * guarantee while merely working.
 *
 * `small` is bound at 4 by its **memory** request: 4 chats is 3.55Gi of the 4Gi it requests and a fifth would be
 * 4.20Gi, outside it. The CPU convention happens to land on the same figure — 5 sessions at 0.93 of its one CPU, a
 * sixth at 1.12 — but that agreement is a coincidence of the two formulas at this one size and is not what fixes the
 * cap. `medium` and `large` are bound by neither: their memory requests would hold 10 and 23 chats, the CPU
 * convention 9 and 20. What binds those two is the evidence. No pod has been measured above two concurrent sessions,
 * and the one burst figure there is, 568m mean over a session's busiest 30s window with 26 throttled periods in it,
 * is of a single session alone. So they sit deliberately well inside both, 6 taking 65% of `medium`'s CPU request
 * and 8 taking 42% of `large`'s at the working mean. Raising them wants a pod driven deliberately with its full
 * complement busy at once, which is the measurement nobody has.
 */
export const CONVERSATION_SESSIONS: Readonly<Record<VirtualAgentSize, number>> = { small: 4, medium: 6, large: 8 };

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
    { name: "AGENT_HUB_MAX_SESSIONS", value: String(CONVERSATION_SESSIONS[isVirtualAgentSize(agent.size) ? agent.size : DEFAULT_SIZE]) },
    { name: "AZURE_TENANT_ID", value: spec.tenantId },
    { name: "DISABLE_AUTOUPDATER", value: "1" },
    // AKS runs containerd, which creates no `/.dockerenv`, and none of hai's other container signals are set in a
    // pod either, so hai cannot infer that it is already containerised. Without this marker it decides it is on a
    // bare host and tries `docker pull` and `docker run --privileged`, which a pod with no Docker socket and
    // `allowPrivilegeEscalation: false` cannot do: it exits 1 and every session dies at launch. Not
    // `HAI_ENV_READY` as well — the two together short-circuit the route resolution that builds the Bedrock
    // environment the `bedrock` route needs.
    { name: "HAI_IN_CONTAINER", value: "1" },
    // A pod runs the hai its entrypoint installed at boot, for its whole lifetime. Boot resolves `@latest` once and
    // this pins that choice: left to itself hai checks npm on every session start, and `CONVERSATION_SESSIONS`
    // starts enough of them at once that concurrent `npm install -g` runs would race on one nvm prefix. It also
    // keeps hai from moving under a running agent mid-work. The image's own hai is only the floor boot keeps when
    // the install fails. Claude Code's DISABLE_AUTOUPDATER is a different switch and does not cover this.
    { name: "HAI_NO_UPDATE", value: "1" },
    { name: "KNOWLEDGE_SWEEP_CHILD", value: "1" },
    { name: "VIRTUAL_AGENT_PUBLIC_DOMAIN", value: spec.publicDomain },
    { name: LAUNCH_TOKEN_ENV, value: launchToken }
  ];
}

/**
 * The CPU and memory of the agent's size, and the same scratch space for every size. Built afresh on every apply, so
 * a StatefulSet made before a size change gets the new resources the next time it is applied.
 *
 * The container gets no CPU limit, so `limits` carries memory and scratch space alone.
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
