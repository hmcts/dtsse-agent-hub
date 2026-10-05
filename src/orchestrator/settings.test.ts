import { describe, expect, it } from "vitest";
import { OrchestratorConfigurationError, orchestratorSettings } from "./settings.ts";

const IMAGE = `hmctsprod.azurecr.io/dtsse/agent-hub-virtual-agent@sha256:${"a".repeat(64)}`;
const TENANT = "531ff96d-0ae9-462a-8d2d-bec7c0b42082";

const ENV = {
  VIRTUAL_AGENT_IMAGE: IMAGE,
  ORCHESTRATOR_CLUSTER: "cft-preview-00",
  AZURE_TENANT_ID: TENANT,
  AZURE_CLIENT_ID: "client",
  AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/azure/tokens/azure-identity-token"
};

describe("orchestratorSettings", () => {
  it("should apply every default when only the required variables are set", () => {
    expect(orchestratorSettings(ENV, "virtual-agents\n")).toEqual({
      cluster: "cft-preview-00",
      namespace: "virtual-agents",
      hubUrl: "https://agent-hub.aat.platform.hmcts.net",
      hubScope: "api://dtsse-agent-hub/.default",
      intervalMs: 10_000,
      orphanSweepEvery: 30,
      port: 8080,
      agent: {
        namespace: "virtual-agents",
        image: IMAGE,
        serviceAccount: "virtual-agent",
        hubUrl: "https://agent-hub.aat.platform.hmcts.net",
        tenantId: TENANT,
        diskSize: "32Gi",
        storageClass: null
      }
    });
  });

  it("should read every optional variable when they are set", () => {
    const settings = orchestratorSettings(
      {
        ...ENV,
        AGENT_HUB_URL: "http://dtsse-agent-hub.dtsse:3000",
        VIRTUAL_AGENT_HUB_URL: "https://agent-hub.example.net",
        AGENT_HUB_AUDIENCE: "api://other/",
        VIRTUAL_AGENT_SERVICE_ACCOUNT: "va",
        VIRTUAL_AGENT_DISK_SIZE: "64Gi",
        VIRTUAL_AGENT_STORAGE_CLASS: "managed-csi-premium",
        ORCHESTRATOR_INTERVAL_SECONDS: "5",
        ORCHESTRATOR_PORT: "9000"
      },
      "ns"
    );

    expect(settings).toMatchObject({ hubUrl: "http://dtsse-agent-hub.dtsse:3000", hubScope: "api://other/.default", intervalMs: 5000, port: 9000 });
    expect(settings.agent).toMatchObject({
      hubUrl: "https://agent-hub.example.net",
      serviceAccount: "va",
      diskSize: "64Gi",
      storageClass: "managed-csi-premium"
    });
  });

  it("should give the virtual agents the orchestrator's hub URL when no other is set", () => {
    expect(orchestratorSettings({ ...ENV, AGENT_HUB_URL: "https://hub.example.net" }, "ns").agent.hubUrl).toBe("https://hub.example.net");
  });

  it("should accept an image with a tag beside its digest", () => {
    expect(orchestratorSettings({ ...ENV, VIRTUAL_AGENT_IMAGE: `registry:5000/a/b:v1@sha256:${"0".repeat(64)}` }, "ns").agent.image).toContain(":v1@");
  });

  it("should list every problem at once when nothing is set", () => {
    let message = "";
    try {
      orchestratorSettings({}, undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestratorConfigurationError);
      message = (error as Error).message;
    }

    expect(message).toMatch(/^the orchestrator cannot start: /);
    for (const expected of [
      "VIRTUAL_AGENT_IMAGE is not set",
      "ORCHESTRATOR_CLUSTER is not set",
      "no namespace",
      "AZURE_TENANT_ID",
      "AZURE_FEDERATED_TOKEN_FILE"
    ]) {
      expect(message).toContain(expected);
    }
  });

  it.each([
    ["an image pinned by tag", { VIRTUAL_AGENT_IMAGE: "hmctsprod.azurecr.io/dtsse/agent:latest" }, /pinned by digest/],
    ["a cluster name with a space", { ORCHESTRATOR_CLUSTER: "cft preview" }, /ORCHESTRATOR_CLUSTER must be/],
    ["a tenant that is not a GUID", { AZURE_TENANT_ID: "hmcts" }, /AZURE_TENANT_ID/],
    ["no federated token file", { AZURE_FEDERATED_TOKEN_FILE: " " }, /AZURE_FEDERATED_TOKEN_FILE/],
    ["a hub URL that is not one", { AGENT_HUB_URL: "agent-hub" }, /AGENT_HUB_URL must be/],
    ["a hub URL of another scheme", { AGENT_HUB_URL: "ftp://agent-hub" }, /AGENT_HUB_URL must be/],
    ["a virtual agent hub URL that is not one", { VIRTUAL_AGENT_HUB_URL: "nope" }, /VIRTUAL_AGENT_HUB_URL must be/],
    ["a service account that is not a name", { VIRTUAL_AGENT_SERVICE_ACCOUNT: "Virtual_Agent" }, /VIRTUAL_AGENT_SERVICE_ACCOUNT/],
    ["a disk size without a unit", { VIRTUAL_AGENT_DISK_SIZE: "32" }, /VIRTUAL_AGENT_DISK_SIZE/],
    ["a storage class that is not a name", { VIRTUAL_AGENT_STORAGE_CLASS: "Premium SSD" }, /VIRTUAL_AGENT_STORAGE_CLASS/],
    ["an interval of zero", { ORCHESTRATOR_INTERVAL_SECONDS: "0" }, /ORCHESTRATOR_INTERVAL_SECONDS/],
    ["an interval that is not whole", { ORCHESTRATOR_INTERVAL_SECONDS: "2.5" }, /ORCHESTRATOR_INTERVAL_SECONDS/],
    ["a port out of range", { ORCHESTRATOR_PORT: "70000" }, /ORCHESTRATOR_PORT/]
  ])("should refuse %s", (_label, override, problem) => {
    expect(() => orchestratorSettings({ ...ENV, ...override }, "ns")).toThrow(problem);
  });

  it("should refuse a namespace file that is blank", () => {
    expect(() => orchestratorSettings(ENV, " \n")).toThrow(/no namespace/);
  });
});
