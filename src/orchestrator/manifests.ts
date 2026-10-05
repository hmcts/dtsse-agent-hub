import type { ClaimedAgent } from "./hub.ts";
import type { Secret, StatefulSet } from "./kube.ts";
import type { VirtualAgentSpec } from "./settings.ts";

/**
 * What the orchestrator applies for each virtual agent. Only StatefulSets: the preview cluster's Gatekeeper refuses
 * a pod no controller owns.
 */

export const MANAGED_BY = "agent-hub-orchestrator";
export const MANAGED_SELECTOR = `app.kubernetes.io/managed-by=${MANAGED_BY}`;
export const ID_LABEL = "agent-hub.hmcts.net/virtual-agent-id";
export const GENERATION_ANNOTATION = "agent-hub.hmcts.net/generation";

const CLAIM_TEMPLATE = "work";
const HOME = "/home/hmcts";
const UID = 1000;

export function launchSecretName(statefulsetName: string): string {
  return `${statefulsetName}-launch`;
}

/** The claim template's PVC for the StatefulSet's one pod, named as Kubernetes names it. */
export function workPvcName(statefulsetName: string): string {
  return `${CLAIM_TEMPLATE}-${statefulsetName}-0`;
}

export function podName(statefulsetName: string): string {
  return `${statefulsetName}-0`;
}

export function labels(id: string): Record<string, string> {
  return { "app.kubernetes.io/name": "virtual-agent", "app.kubernetes.io/managed-by": MANAGED_BY, [ID_LABEL]: id };
}

export function launchSecret(agent: ClaimedAgent & { launch_token: string }, namespace: string): Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: launchSecretName(agent.statefulset_name), namespace, labels: labels(agent.id) },
    type: "Opaque",
    data: { token: Buffer.from(agent.launch_token, "utf8").toString("base64") }
  };
}

function env(agent: ClaimedAgent, spec: VirtualAgentSpec) {
  return [
    { name: "AGENT_HUB_URL", value: spec.hubUrl },
    { name: "AGENT_HUB_VIRTUAL", value: "1" },
    { name: "AGENT_HUB_VIRTUAL_AGENT_ID", value: agent.id },
    { name: "AGENT_HUB_MODEL_ROUTE", value: agent.model_route },
    { name: "AZURE_TENANT_ID", value: spec.tenantId },
    { name: "DISABLE_AUTOUPDATER", value: "1" },
    { name: "KNOWLEDGE_SWEEP_CHILD", value: "1" },
    { name: "AGENT_HUB_LAUNCH_TOKEN", valueFrom: { secretKeyRef: { name: launchSecretName(agent.statefulset_name), key: "token" } } }
  ];
}

/** A StatefulSet's claim template cannot change once created, so an existing agent keeps the disk it was made with. */
export interface Disk {
  size: string;
  storageClass: string | null;
}

/** The disk an existing StatefulSet was created with, or `undefined` when it has no claim template to read. */
export function existingDisk(existing: StatefulSet | null): Disk | undefined {
  const templates = existing?.spec?.volumeClaimTemplates;
  const template = Array.isArray(templates)
    ? (templates[0] as { spec?: { resources?: { requests?: { storage?: unknown } }; storageClassName?: unknown } })
    : undefined;
  const size = template?.spec?.resources?.requests?.storage;
  if (typeof size !== "string") {
    return undefined;
  }
  const storageClass = template?.spec?.storageClassName;
  return { size, storageClass: typeof storageClass === "string" ? storageClass : null };
}
/**
 * The pod template carries the claim's generation, so starting an agent again replaces a pod that is still there
 * with one that reads the newly minted launch token; a claim of the same generation changes nothing.
 */
export function statefulSet(agent: ClaimedAgent, spec: VirtualAgentSpec, disk: Disk = { size: spec.diskSize, storageClass: spec.storageClass }): StatefulSet {
  const name = agent.statefulset_name;
  const tagged = labels(agent.id);
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name, namespace: spec.namespace, labels: tagged },
    spec: {
      replicas: agent.desired === "running" ? 1 : 0,
      serviceName: name,
      selector: { matchLabels: { [ID_LABEL]: agent.id } },
      template: {
        metadata: { labels: tagged, annotations: { [GENERATION_ANNOTATION]: String(agent.generation) } },
        spec: {
          serviceAccountName: spec.serviceAccount,
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 60,
          securityContext: {
            runAsUser: UID,
            runAsGroup: UID,
            fsGroup: UID,
            runAsNonRoot: true,
            seccompProfile: { type: "RuntimeDefault" }
          },
          containers: [
            {
              name: "agent",
              image: spec.image,
              command: ["virtual-agent-boot"],
              env: env(agent, spec),
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
              resources: {
                requests: { cpu: "1", memory: "4Gi", "ephemeral-storage": "2Gi" },
                limits: { cpu: "4", memory: "8Gi", "ephemeral-storage": "10Gi" }
              },
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
