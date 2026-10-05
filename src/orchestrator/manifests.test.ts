import { describe, expect, it } from "vitest";
import type { ClaimedAgent } from "./hub.ts";
import type { StatefulSet } from "./kube.ts";
import { carriedOver, exposedPorts, ingress, podName, resources, service, statefulSet } from "./manifests.ts";
import type { VirtualAgentSpec } from "./settings.ts";

const ID = "0f8a6a1e-1234-4000-8000-000000000001";
const TOKEN = "ahv_launch";

const AGENT: ClaimedAgent = {
  id: ID,
  generation: 3,
  desired: "running",
  statefulset_name: "va-0f8a6a1e",
  pvc_name: "work-va-0f8a6a1e-0",
  delete_disk: false,
  model_route: "bedrock",
  owner: { oid: "owner" }
};

const SPEC: VirtualAgentSpec = {
  namespace: "dtsse",
  image: `registry.example/agent@sha256:${"b".repeat(64)}`,
  serviceAccount: "default",
  hubUrl: "https://agent-hub.aat.platform.hmcts.net",
  tenantId: "tenant",
  diskSize: "32Gi",
  storageClass: null,
  hostAliases: [],
  publicDomain: "preview.platform.hmcts.net"
};

const LABELS = {
  "app.kubernetes.io/name": "virtual-agent",
  "app.kubernetes.io/managed-by": "agent-hub-orchestrator",
  "agent-hub.hmcts.net/virtual-agent-id": ID
};

type PodSpec = {
  containers: { env: { name: string; value?: string }[]; [key: string]: unknown }[];
  volumes: unknown[];
  [key: string]: unknown;
};

function podSpec(set: StatefulSet): PodSpec {
  return (set.spec as unknown as { template: { spec: PodSpec } }).template.spec;
}

function claimTemplate(set: StatefulSet): { metadata: unknown; spec: Record<string, unknown> } {
  return (set.spec as unknown as { volumeClaimTemplates: { metadata: unknown; spec: Record<string, unknown> }[] }).volumeClaimTemplates[0]!;
}

function statefulSetWith(spec: unknown): StatefulSet {
  return { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "x" }, spec } as StatefulSet;
}

describe("podName", () => {
  it("should name the one pod after the StatefulSet with ordinal 0", () => {
    expect(podName("va-1")).toBe("va-1-0");
  });
});

describe("statefulSet", () => {
  it("should run one replica with the agent's labels and generation when it is meant to be running", () => {
    const set = statefulSet(AGENT, SPEC, TOKEN);

    expect(set.metadata).toEqual({ name: "va-0f8a6a1e", namespace: "dtsse", labels: LABELS });
    expect(set.spec).toMatchObject({
      replicas: 1,
      serviceName: "va-0f8a6a1e",
      selector: { matchLabels: { "agent-hub.hmcts.net/virtual-agent-id": ID } },
      template: { metadata: { labels: LABELS, annotations: { "agent-hub.hmcts.net/generation": "3" } } }
    });
  });

  it.each(["stopped", "deleted"] as const)("should run no replica when it is meant to be %s", (desired) => {
    expect(statefulSet({ ...AGENT, desired }, SPEC, TOKEN).spec?.replicas).toBe(0);
  });

  it("should delete the disk with the StatefulSet and keep it when it scales to zero", () => {
    expect(statefulSet(AGENT, SPEC, TOKEN).spec?.persistentVolumeClaimRetentionPolicy).toEqual({ whenDeleted: "Delete", whenScaled: "Retain" });
  });

  it("should run the pod unprivileged, without a ServiceAccount token or workload identity", () => {
    const spec = podSpec(statefulSet(AGENT, SPEC, TOKEN));

    expect(spec).toMatchObject({
      serviceAccountName: "default",
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 60,
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } }
    });
    expect(JSON.stringify(statefulSet(AGENT, SPEC, TOKEN))).not.toContain("azure.workload.identity");
  });

  it("should run the boot script in the image with the agent's sizes and mounts", () => {
    const [container] = podSpec(statefulSet(AGENT, SPEC, TOKEN)).containers;

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
    expect(podSpec(statefulSet(AGENT, SPEC, TOKEN)).volumes).toEqual([
      { name: "azure", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
      { name: "gh", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } }
    ]);
  });

  it("should give the pod its hub, identity, model route and launch token as plain values", () => {
    const [container] = podSpec(statefulSet({ ...AGENT, model_route: "own_licence" }, SPEC, TOKEN)).containers;

    expect(container!.env).toEqual([
      { name: "AGENT_HUB_URL", value: "https://agent-hub.aat.platform.hmcts.net" },
      { name: "AGENT_HUB_VIRTUAL", value: "1" },
      { name: "AGENT_HUB_VIRTUAL_AGENT_ID", value: ID },
      { name: "AGENT_HUB_MODEL_ROUTE", value: "own_licence" },
      { name: "AZURE_TENANT_ID", value: "tenant" },
      { name: "DISABLE_AUTOUPDATER", value: "1" },
      { name: "KNOWLEDGE_SWEEP_CHILD", value: "1" },
      { name: "AGENT_HUB_LAUNCH_TOKEN", value: TOKEN }
    ]);
  });

  it("should claim a disk of the configured size on the cluster's default class when no class is set", () => {
    expect(claimTemplate(statefulSet(AGENT, SPEC, TOKEN))).toEqual({
      metadata: { name: "work", labels: LABELS },
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "32Gi" } } }
    });
  });

  it("should claim the disk on the configured class when one is set", () => {
    expect(claimTemplate(statefulSet(AGENT, { ...SPEC, storageClass: "managed-csi-premium" }, TOKEN)).spec.storageClassName).toBe("managed-csi-premium");
  });

  it("should keep the disk an existing StatefulSet was made with when one is carried over", () => {
    expect(claimTemplate(statefulSet(AGENT, SPEC, TOKEN, { disk: { size: "16Gi", storageClass: "old" } })).spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "16Gi" } },
      storageClassName: "old"
    });
  });

  it("should use the configured disk when what is carried over has none", () => {
    expect(claimTemplate(statefulSet(AGENT, SPEC, TOKEN, { launchToken: "other" })).spec).toMatchObject({ resources: { requests: { storage: "32Gi" } } });
  });
});

describe("carriedOver", () => {
  it("should carry the disk and the launch token when the StatefulSet has both", () => {
    expect(carriedOver(statefulSet(AGENT, { ...SPEC, diskSize: "8Gi", storageClass: "fast" }, TOKEN))).toEqual({
      disk: { size: "8Gi", storageClass: "fast" },
      launchToken: TOKEN
    });
  });

  it("should carry no class when the claim template names none", () => {
    expect(carriedOver(statefulSet(AGENT, SPEC, TOKEN)).disk).toEqual({ size: "32Gi", storageClass: null });
  });

  it.each([
    ["there is no StatefulSet", null],
    ["it has no spec", { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "x" } } as StatefulSet],
    ["its spec is empty", statefulSetWith({})],
    ["its claim template has no size and its pod no containers", statefulSetWith({ volumeClaimTemplates: [{}], template: { spec: {} } })],
    ["its claim templates are not a list", statefulSetWith({ volumeClaimTemplates: {} })],
    [
      "it has no agent container",
      statefulSetWith({ template: { spec: { containers: [{ name: "other", env: [{ name: "AGENT_HUB_LAUNCH_TOKEN", value: "x" }] }] } } })
    ],
    ["its container has no env", statefulSetWith({ template: { spec: { containers: [{ name: "agent" }] } } })],
    ["its token is empty", statefulSetWith({ template: { spec: { containers: [{ name: "agent", env: [{ name: "AGENT_HUB_LAUNCH_TOKEN", value: "" }] }] } } })],
    [
      "its token comes from elsewhere",
      statefulSetWith({ template: { spec: { containers: [{ name: "agent", env: [{ name: "AGENT_HUB_LAUNCH_TOKEN", valueFrom: {} }] }] } } })
    ]
  ])("should carry nothing when %s", (_label, existing) => {
    expect(carriedOver(existing)).toEqual({});
  });
});

describe("resources", () => {
  it.each([
    ["small", { cpu: "1", memory: "4Gi" }, { cpu: "4", memory: "8Gi" }],
    ["medium", { cpu: "2", memory: "8Gi" }, { cpu: "4", memory: "16Gi" }],
    ["large", { cpu: "4", memory: "16Gi" }, { cpu: "8", memory: "32Gi" }]
  ] as const)("should give a %s agent its CPU and memory with the same scratch space as every size", (size, requests, limits) => {
    expect(resources({ size })).toEqual({
      requests: { ...requests, "ephemeral-storage": "2Gi" },
      limits: { ...limits, "ephemeral-storage": "10Gi" }
    });
  });

  it.each([
    ["no size", {}],
    ["a size it does not know", { size: "huge" as never }]
  ])("should size the agent small when the claim has %s", (_label, agent) => {
    expect(resources(agent)).toEqual(resources({ size: "small" }));
  });

  it("should put the claim's size on the container when the StatefulSet is built", () => {
    const [container] = podSpec(statefulSet({ ...AGENT, size: "large" }, SPEC, TOKEN)).containers;

    expect(container!.resources).toEqual(resources({ size: "large" }));
  });
});

describe("host aliases", () => {
  it("should add the configured host aliases to the pod when there are some", () => {
    const aliases = [{ ip: "10.10.73.250", hostnames: ["build.hmcts.net"] }];

    expect(podSpec(statefulSet(AGENT, { ...SPEC, hostAliases: aliases }, TOKEN)).hostAliases).toEqual(aliases);
  });

  it("should leave host aliases out when none are configured", () => {
    expect(podSpec(statefulSet(AGENT, SPEC, TOKEN))).not.toHaveProperty("hostAliases");
  });
});

describe("exposed ports", () => {
  const EXPOSED: ClaimedAgent = { ...AGENT, exposed_ports: [3000, 8080] };

  it("should treat a claim with no exposed ports as exposing none", () => {
    expect(exposedPorts(AGENT)).toEqual([]);
    expect(exposedPorts({ exposed_ports: [3000] })).toEqual([3000]);
  });

  it("should give the pod each port's public URL when it exposes ports", () => {
    const [container] = podSpec(statefulSet(EXPOSED, SPEC, TOKEN)).containers;

    expect(container!.env.at(-1)).toEqual({
      name: "AGENT_HUB_PUBLIC_URLS",
      value: "3000=https://va-0f8a6a1e-3000.preview.platform.hmcts.net,8080=https://va-0f8a6a1e-8080.preview.platform.hmcts.net"
    });
  });

  it("should give the pod no public URLs when it exposes no ports", () => {
    const [container] = podSpec(statefulSet(AGENT, SPEC, TOKEN)).containers;

    expect(container!.env.map((entry) => entry.name)).not.toContain("AGENT_HUB_PUBLIC_URLS");
  });

  it("should put a ClusterIP Service labelled as the agent's in front of its pod with one port per exposed port", () => {
    expect(service(EXPOSED, SPEC)).toEqual({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "va-0f8a6a1e", namespace: "dtsse", labels: LABELS },
      spec: {
        type: "ClusterIP",
        selector: { "agent-hub.hmcts.net/virtual-agent-id": ID },
        ports: [
          { name: "p-3000", port: 3000, targetPort: 3000, protocol: "TCP" },
          { name: "p-8080", port: 8080, targetPort: 8080, protocol: "TCP" }
        ]
      }
    });
  });

  it("should route one Traefik TLS host per exposed port to the Service on that port", () => {
    expect(ingress(EXPOSED, { ...SPEC, publicDomain: "example.net" })).toEqual({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: { name: "va-0f8a6a1e", namespace: "dtsse", labels: LABELS, annotations: { "traefik.ingress.kubernetes.io/router.tls": "true" } },
      spec: {
        ingressClassName: "traefik",
        rules: [3000, 8080].map((port) => ({
          host: `va-0f8a6a1e-${port}.example.net`,
          http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "va-0f8a6a1e", port: { number: port } } } }] }
        }))
      }
    });
  });
});
