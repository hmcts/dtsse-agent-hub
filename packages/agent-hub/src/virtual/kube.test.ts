// The pod's kube contexts, against fake az, kubelogin and kubectl on PATH that record what they were called
// with. No cluster is ever reached.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { captureStderr, createPodShims, type PodShims, usePodEnv } from "../__fixtures__/pod-shims.ts";
import { AAT_CLUSTERS, AAT_SUBSCRIPTION, clustersFor, configureKubeContexts, contextFor, PREVIEW_SUBSCRIPTION, subscriptionFor } from "./kube.ts";

const VID = "0f8a6a1e-1234-4000-8000-000000000001";

let pod: PodShims;
let restoreEnv: () => void;

/** Every argv the fakes recorded, one line per call, in the order they were called. */
const calls = (): string[] => {
  const log = path.join(pod.stateDir, "kube.log");
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
};

/** `az` answers for the clusters `aks` names and fails for the rest, as it does for one nobody can read. */
const shims = ({ aks = "all", kubelogin = 0, kubectl = 0 }: { aks?: string; kubelogin?: number; kubectl?: number } = {}) => {
  pod.shim(
    "az",
    `echo "az $*" >> "$SHIM_STATE/kube.log"
[ "${aks}" = "all" ] && exit 0
for ok in ${aks}; do case "$*" in *"$ok"*) exit 0 ;; esac; done
echo "ERROR: (ResourceGroupNotFound)" >&2
exit 1`
  );
  pod.shim("kubelogin", `echo "kubelogin $*" >> "$SHIM_STATE/kube.log"\nexit ${kubelogin}`);
  pod.shim("kubectl", `echo "kubectl $*" >> "$SHIM_STATE/kube.log"\nexit ${kubectl}`);
};

beforeAll(() => {
  pod = createPodShims({ virtualId: VID, hubUrl: "http://127.0.0.1:1" });
  restoreEnv = usePodEnv(pod.home);
});

afterEach(() => {
  // pod.reset() restores the shims the fixture owns; this log is this file's own.
  fs.rmSync(path.join(pod.stateDir, "kube.log"), { force: true });
  pod.reset();
});

afterAll(() => {
  restoreEnv();
  pod.cleanup();
});

describe("subscriptionFor", () => {
  it("should name the dev subscription when the cluster is a preview one", () => {
    expect(subscriptionFor("cft-preview-00")).toBe(PREVIEW_SUBSCRIPTION);
    expect(subscriptionFor("cft-preview-07")).toBe(PREVIEW_SUBSCRIPTION);
  });

  it("should name the staging subscription when the cluster is an AAT one", () => {
    expect(subscriptionFor("cft-aat-01")).toBe(AAT_SUBSCRIPTION);
  });

  it("should name none when the cluster is neither", () => {
    expect(subscriptionFor("cft-prod-00")).toBeUndefined();
    expect(subscriptionFor("ss-dev-00")).toBeUndefined();
  });
});

describe("clustersFor", () => {
  it("should put the pod's own cluster first when it has one", () => {
    expect(clustersFor({ AGENT_HUB_CLUSTER: "cft-preview-01" })).toEqual(["cft-preview-01", ...AAT_CLUSTERS]);
  });

  it("should name a cluster once when the pod runs in one that is also in the standing list", () => {
    expect(clustersFor({ AGENT_HUB_CLUSTER: "cft-aat-00" })).toEqual(["cft-aat-00", "cft-aat-01"]);
  });

  it("should give the standing list alone when the pod is not told its cluster", () => {
    expect(clustersFor({})).toEqual([...AAT_CLUSTERS]);
  });

  it("should never name a prod cluster", () => {
    expect(clustersFor({ AGENT_HUB_CLUSTER: "cft-preview-00" }).join(" ")).not.toContain("prod");
  });
});

describe("configureKubeContexts", () => {
  it("should get credentials for the pod's cluster and both AAT clusters when az answers", async () => {
    shims();
    const env = pod.env({ AGENT_HUB_CLUSTER: "cft-preview-00" });

    const { result } = await captureStderr(() => configureKubeContexts({ env }));

    expect(result).toBe("configured");
    expect(calls().filter((c) => c.startsWith("az aks get-credentials"))).toHaveLength(3);
    expect(calls()[0]).toContain(`--subscription ${PREVIEW_SUBSCRIPTION} --resource-group cft-preview-00-rg --name cft-preview-00-aks`);
    expect(calls()[1]).toContain(`--subscription ${AAT_SUBSCRIPTION} --resource-group cft-aat-00-rg`);
  });

  it("should convert the kubeconfig to the signed-in az when the credentials are written", async () => {
    shims();

    await captureStderr(() => configureKubeContexts({ env: pod.env({ AGENT_HUB_CLUSTER: "cft-preview-00" }) }));

    expect(calls()).toContain("kubelogin convert-kubeconfig -l azurecli");
  });

  it("should select the pod's own cluster when it is told which one it is in", async () => {
    shims();

    const { stderr } = await captureStderr(() => configureKubeContexts({ env: pod.env({ AGENT_HUB_CLUSTER: "cft-preview-00" }) }));

    expect(calls()).toContain("kubectl config use-context cft-preview-00-aks");
    expect(stderr).toContain("the current one is cft-preview-00-aks");
  });

  it("should leave kubectl needing a context when the pod is not told its cluster", async () => {
    shims();

    const { result, stderr } = await captureStderr(() => configureKubeContexts({ env: pod.env() }));

    expect(result).toBe("configured");
    expect(calls().some((c) => c.startsWith("kubectl config use-context"))).toBe(false);
    expect(stderr).toContain("kubectl needs --context");
  });

  it("should configure the clusters that answered when one of them does not", async () => {
    shims({ aks: "cft-preview-00 cft-aat-00" });

    const { result, stderr } = await captureStderr(() => configureKubeContexts({ env: pod.env({ AGENT_HUB_CLUSTER: "cft-preview-00" }) }));

    expect(result).toBe("configured");
    expect(stderr).toContain("cft-aat-01: az aks get-credentials failed");
    expect(stderr).toContain("2 context(s) configured");
  });

  it("should configure nothing when no cluster answers, which is an owner with no AKS access", async () => {
    shims({ aks: "none-of-them" });

    const { result, stderr } = await captureStderr(() => configureKubeContexts({ env: pod.env({ AGENT_HUB_CLUSTER: "cft-preview-00" }) }));

    expect(result).toBe("not-configured");
    expect(stderr).toContain("kubectl is not configured");
    expect(calls().some((c) => c.startsWith("kubelogin"))).toBe(false);
  });

  it("should report not configured when kubelogin cannot convert the kubeconfig", async () => {
    shims({ kubelogin: 1 });

    const { result, stderr } = await captureStderr(() => configureKubeContexts({ env: pod.env({ AGENT_HUB_CLUSTER: "cft-preview-00" }) }));

    expect(result).toBe("not-configured");
    expect(stderr).toContain("would ask for a device code");
  });

  it("should skip a cluster no subscription is known for when the pod reports an unexpected one", async () => {
    shims();

    const { stderr } = await captureStderr(() => configureKubeContexts({ env: pod.env({ AGENT_HUB_CLUSTER: "cft-prod-00" }) }));

    expect(stderr).toContain("cft-prod-00: no subscription is known");
    expect(calls().some((c) => c.includes("cft-prod-00-rg"))).toBe(false);
  });

  it("should still configure the AAT clusters when selecting the pod's own context fails", async () => {
    shims({ kubectl: 1 });

    const { result, stderr } = await captureStderr(() => configureKubeContexts({ env: pod.env({ AGENT_HUB_CLUSTER: "cft-preview-00" }) }));

    expect(result).toBe("configured");
    expect(stderr).toContain("kubectl needs --context");
  });
});

describe("contextFor", () => {
  it("should name the context as the cluster plus -aks when a cluster is given", () => {
    expect(contextFor("cft-aat-01")).toBe("cft-aat-01-aks");
  });
});
