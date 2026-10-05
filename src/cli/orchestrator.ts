import { readFileSync } from "node:fs";
import { WorkloadIdentityCredential } from "@azure/identity";
import { createHealth, type Health, healthServer } from "../orchestrator/health.ts";
import { createHub } from "../orchestrator/hub.ts";
import { createKube, inClusterConfig, type KubeConfig, SERVICE_ACCOUNT_DIR } from "../orchestrator/kube.ts";
import { createLogger, describeError, type Log } from "../orchestrator/log.ts";
import { initialState, type ReconcileDeps, type ReconcileState, reconcilePass } from "../orchestrator/reconcile.ts";
import { type OrchestratorSettings, orchestratorSettings } from "../orchestrator/settings.ts";

/** The virtual-agent orchestrator: `node dist/cli/orchestrator.js`, in the image the hub also runs. */

const log: Log = createLogger();

function readNamespace(): string | undefined {
  try {
    return readFileSync(`${SERVICE_ACCOUNT_DIR}/namespace`, "utf8");
  } catch {
    return undefined;
  }
}

/** The settings and the API server's connection, or `undefined` once the reason it cannot start is logged. */
function startup(): { settings: OrchestratorSettings; kubeConfig: KubeConfig } | undefined {
  let settings: OrchestratorSettings;
  let kubeConfig: KubeConfig | undefined;
  try {
    settings = orchestratorSettings(process.env, readNamespace());
    kubeConfig = inClusterConfig();
  } catch (error) {
    log("error", describeError(error));
    return undefined;
  }
  if (kubeConfig === undefined) {
    log("error", "the orchestrator cannot start: KUBERNETES_SERVICE_HOST is not set, so this is not running in a Kubernetes pod");
    return undefined;
  }
  return { settings, kubeConfig };
}

async function pass(deps: ReconcileDeps, state: ReconcileState, health: Health): Promise<void> {
  try {
    const result = await reconcilePass(deps, state);
    health.passed();
    if (result.claimed > 0 || result.reported > 0 || result.errors > 0 || result.orphans > 0) {
      log(result.errors > 0 ? "warn" : "info", "pass", { ...result, watching: state.watching.size });
    }
  } catch (error) {
    log("error", "pass failed", { error: describeError(error) });
  }
}

/** Waits `ms`, or until `stop` aborts. */
function pause(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    stop.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

async function run(): Promise<number> {
  const started = startup();
  if (started === undefined) {
    return 1;
  }
  const { settings, kubeConfig } = started;

  // Workload identity only: DefaultAzureCredential would fall back to the node's managed identity, whose token the
  // hub refuses with nothing in the log to say why.
  const hub = createHub({ url: settings.hubUrl, scope: settings.hubScope, credential: new WorkloadIdentityCredential() });
  const deps: ReconcileDeps = { kube: createKube(kubeConfig), hub, settings, log };
  const health = createHealth(settings.intervalMs);
  const server = healthServer(health).listen(settings.port);
  const state = initialState();

  const stopping = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      log("info", "stopping after this pass", { signal });
      stopping.abort();
    });
  }

  log("info", "started", {
    cluster: settings.cluster,
    namespace: settings.namespace,
    hub: settings.hubUrl,
    interval_ms: settings.intervalMs,
    port: settings.port
  });
  // One pass at a time, by design: a pass never overlaps the one before it.
  while (!stopping.signal.aborted) {
    await pass(deps, state, health);
    await pause(settings.intervalMs, stopping.signal);
  }
  await new Promise((resolve) => server.close(resolve));
  log("info", "stopped");
  return 0;
}

void run().then((code) => {
  process.exit(code);
});
