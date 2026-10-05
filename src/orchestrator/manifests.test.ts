import { describe, expect, it } from "vitest";
import type { ClaimedAgent } from "./hub.ts";
import type { StatefulSet } from "./kube.ts";
import { existingDisk, launchSecret, launchSecretName, podName, statefulSet, workPvcName } from "./manifests.ts";
import type { VirtualAgentSpec } from "./settings.ts";

const ID = "0f8a6a1e-1234-4000-8000-000000000001";

const AGENT: ClaimedAgent = {
  id: ID,
  generation: 3,
  desired: "running",
  statefulset_name: "va-0f8a6a1e",
  pvc_name: "va-0f8a6a1e",
  delete_disk: false,
  model_route: "gateway",
  owner: { oid: "owner" }
};

const SPEC: VirtualAgentSpec = {
  namespace: "virtual-agents",
  image: `registry.example/agent@sha256:${"b".repeat(64)}`,
  serviceAccount: "virtual-agent",
  hubUrl: "https://agent-hub.aat.platform.hmcts.net",
  tenantId: "tenant",
  diskSize: "32Gi",
  storageClass: null
};

const LABELS = {
  "app.kubernetes.io/name": "virtual-agent",
  "app.kubernetes.io/managed-by": "agent-hub-orchestrator",
  "agent-hub.hmcts.net/virtual-agent-id": ID
};

type PodSpec = {
  serviceAccountName: string;
  automountServiceAccountToken: boolean;
  terminationGracePeriodSeconds: number;
  securityContext: unknown;
  containers: { env: { name: string; value?: string; valueFrom?: unknown }[]; [key: string]: unknown }[];
  volumes: unknown[];
  [key: string]: unknown;
};

function podSpec(set: StatefulSet): PodSpec {
  return (set.spec as unknown as { template: { spec: PodSpec } }).template.spec;
}

function claimTemplate(set: StatefulSet): { metadata: unknown; spec: Record<string, unknown> } {
  return (set.spec as unknown as { volumeClaimTemplates: { metadata: unknown; spec: Record<string, unknown> }[] }).volumeClaimTemplates[0]!;
}

describe("names", () => {
  it("should name the Secret, the pod and the PVC after the StatefulSet when it is va-<id>", () => {
    expect([launchSecretName("va-1"), podName("va-1"), workPvcName("va-1")]).toEqual(["va-1-launch", "va-1-0", "work-va-1-0"]);
  });
});

describe("launchSecret", () => {
  it("should hold the launch token base64-encoded under token, labelled for the agent", () => {
    expect(launchSecret({ ...AGENT, launch_token: "ahv_secret" }, "virtual-agents")).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "va-0f8a6a1e-launch", namespace: "virtual-agents", labels: LABELS },
      type: "Opaque",
      data: { token: Buffer.from("ahv_secret").toString("base64") }
    });
  });
});

describe("statefulSet", () => {
  it("should run one replica with the agent's labels and generation when it is meant to be running", () => {
    const set = statefulSet(AGENT, SPEC);

    expect(set.metadata).toEqual({ name: "va-0f8a6a1e", namespace: "virtual-agents", labels: LABELS });
    expect(set.spec).toMatchObject({
      replicas: 1,
      serviceName: "va-0f8a6a1e",
      selector: { matchLabels: { "agent-hub.hmcts.net/virtual-agent-id": ID } },
      template: { metadata: { labels: LABELS, annotations: { "agent-hub.hmcts.net/generation": "3" } } }
    });
  });

  it.each(["stopped", "deleted"] as const)("should run no replica when it is meant to be %s", (desired) => {
    expect(statefulSet({ ...AGENT, desired }, SPEC).spec?.replicas).toBe(0);
  });

  it("should run the pod unprivileged, without a ServiceAccount token or workload identity", () => {
    const spec = podSpec(statefulSet(AGENT, SPEC));

    expect(spec).toMatchObject({
      serviceAccountName: "virtual-agent",
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 60,
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } }
    });
    expect(JSON.stringify(statefulSet(AGENT, SPEC))).not.toContain("azure.workload.identity");
  });

  it("should run the boot script in the image with the agent's sizes and mounts", () => {
    const [container] = podSpec(statefulSet(AGENT, SPEC)).containers;

    expect(container).toMatchObject({
      name: "agent",
      image: SPEC.image,
      command: ["virtual-agent-boot"],
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
      resources: {
        requests: { cpu: "1", memory: "4Gi", "ephemeral-storage": "2Gi" },
        limits: { cpu: "4", memory: "8Gi", "ephemeral-storage": "10Gi" }
      },
      volumeMounts: [
        { name: "work", mountPath: "/workspace", subPath: "workspace" },
        { name: "work", mountPath: "/home/hmcts/.claude", subPath: "claude" },
        { name: "azure", mountPath: "/home/hmcts/.azure" },
        { name: "gh", mountPath: "/home/hmcts/.config/gh" }
      ]
    });
    expect(podSpec(statefulSet(AGENT, SPEC)).volumes).toEqual([
      { name: "azure", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
      { name: "gh", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } }
    ]);
  });

  it("should give the pod its hub, identity and model route, and the launch token from its Secret", () => {
    const [container] = podSpec(statefulSet({ ...AGENT, model_route: "own_licence" }, SPEC)).containers;

    expect(container!.env).toEqual([
      { name: "AGENT_HUB_URL", value: "https://agent-hub.aat.platform.hmcts.net" },
      { name: "AGENT_HUB_VIRTUAL", value: "1" },
      { name: "AGENT_HUB_VIRTUAL_AGENT_ID", value: ID },
      { name: "AGENT_HUB_MODEL_ROUTE", value: "own_licence" },
      { name: "AZURE_TENANT_ID", value: "tenant" },
      { name: "DISABLE_AUTOUPDATER", value: "1" },
      { name: "KNOWLEDGE_SWEEP_CHILD", value: "1" },
      { name: "AGENT_HUB_LAUNCH_TOKEN", valueFrom: { secretKeyRef: { name: "va-0f8a6a1e-launch", key: "token" } } }
    ]);
  });

  it("should claim a disk of the configured size on the cluster's default class when no class is set", () => {
    expect(claimTemplate(statefulSet(AGENT, SPEC))).toEqual({
      metadata: { name: "work", labels: LABELS },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "32Gi" } } }
    });
  });

  it("should claim the disk on the configured class when one is set", () => {
    expect(claimTemplate(statefulSet(AGENT, { ...SPEC, storageClass: "managed-csi-premium" })).spec.storageClassName).toBe("managed-csi-premium");
  });

  it("should keep the disk an existing StatefulSet was made with when one is passed", () => {
    expect(claimTemplate(statefulSet(AGENT, SPEC, { size: "16Gi", storageClass: "old" })).spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "16Gi" } },
      storageClassName: "old"
    });
  });
});

describe("existingDisk", () => {
  it("should read the size and class when the StatefulSet has a claim template", () => {
    expect(existingDisk(statefulSet(AGENT, { ...SPEC, diskSize: "8Gi", storageClass: "fast" }))).toEqual({ size: "8Gi", storageClass: "fast" });
  });

  it("should read no class when the template names none", () => {
    expect(existingDisk(statefulSet(AGENT, SPEC))).toEqual({ size: "32Gi", storageClass: null });
  });

  it.each([
    ["there is no StatefulSet", null],
    ["it has no spec", { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "x" } }],
    ["it has no claim templates", { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "x" }, spec: {} }],
    ["its template has no size", { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "x" }, spec: { volumeClaimTemplates: [{}] } }]
  ])("should be undefined when %s", (_label, existing) => {
    expect(existingDisk(existing as StatefulSet | null)).toBeUndefined();
  });
});
