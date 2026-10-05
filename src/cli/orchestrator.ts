import { readFileSync } from "node:fs";
import { WorkloadIdentityCredential } from "@azure/identity";
import { createHealth, healthServer } from "../orchestrator/health.ts";
import { createHub } from "../orchestrator/hub.ts";
import { createKube, inClusterConfig, SERVICE_ACCOUNT_DIR } from "../orchestrator/kube.ts";
import { initialState, type Level, reconcilePass } from "../orchestrator/reconcile.ts";
import { orchestratorSettings } from "../orchestrator/settings.ts";

/** The virtual-agent orchestrator: `node dist/cli/orchestrator.js`, in the image the hub also runs. */

function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }));
}

function readNamespace(): string | undefined {
  try {
    return readFileSync(`${SERVICE_ACCOUNT_DIR}/namespace`, "utf8");
  } catch {
    return undefined;
  }
}

async function run(): Promise<number> {
  let settings: ReturnType<typeof orchestratorSettings>;
  let kubeConfig: ReturnType<typeof inClusterConfig>;
  try {
    settings = orchestratorSettings(process.env, readNamespace());
    kubeConfig = inClusterConfig();
  } catch (error) {
    log("error", error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (kubeConfig === undefined) {
    log("error", "the orchestrator cannot start: KUBERNETES_SERVICE_HOST is not set, so this is not running in a Kubernetes pod");
    return 1;
  }

  // Workload identity only: DefaultAzureCredential would fall back to the node's managed identity, whose token the
  // hub refuses with nothing in the log to say why.
  const hub = createHub({ url: settings.hubUrl, scope: settings.hubScope, credential: new WorkloadIdentityCredential() });
  const kube = createKube(kubeConfig);
  const health = createHealth(settings.intervalMs);
  const server = healthServer(health).listen(settings.port);
  const state = initialState();

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (signal: string) => {
    log("info", "stopping after this pass", { signal });
    stopping = true;
    wake?.();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  log("info", "started", {
    cluster: settings.cluster,
    namespace: settings.namespace,
    hub: settings.hubUrl,
    interval_ms: settings.intervalMs,
    port: settings.port
  });
  while (!stopping) {
    try {
      const result = await reconcilePass({ kube, hub, settings, log }, state);
      health.passed();
      if (result.claimed > 0 || result.reported > 0 || result.errors > 0 || result.orphans > 0) {
        log(result.errors > 0 ? "warn" : "info", "pass", { ...result, watching: state.watching.size });
      }
    } catch (error) {
      log("error", "pass failed", { error: error instanceof Error ? error.message : String(error) });
    }
    if (!stopping) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, settings.intervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  }
  await new Promise((resolve) => server.close(resolve));
  log("info", "stopped");
  return 0;
}

void run().then((code) => {
  process.exit(code);
});
