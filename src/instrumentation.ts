import { createRequire } from "node:module";
import { loadSecrets } from "./platform/secrets.ts";

type Platform = typeof import("@hmcts-cft/cloud-native-platform");

const load = createRequire(import.meta.url);

function platform(): Platform {
  return load("@hmcts-cft/cloud-native-platform") as Platform;
}

export async function register(): Promise<void> {
  await readSecrets();
  startMonitoring();
  await startRealtime();
  await startSweeping();
}

async function readSecrets(): Promise<void> {
  await loadSecrets((chartPath) => platform().getPropertiesVolumeSecrets({ chartPath, failOnError: false }));
}

function startMonitoring(): void {
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    return;
  }

  try {
    new (platform().MonitoringService)(connectionString, "dtsse-agent-hub");
  } catch (error) {
    console.warn(`could not start Application Insights: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Opens the pod's LISTEN connection at boot rather than on the first stream. After `readSecrets`, because its
 * connection string is assembled from the mounted `POSTGRES_*`.
 */
async function startRealtime(): Promise<void> {
  try {
    const { realtime } = await import("./realtime/process.ts");
    realtime();
  } catch (error) {
    console.warn(`could not start the realtime listener: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Marks silent agents offline every 30 seconds. Imported dynamically, after `readSecrets`, because `store/prisma.ts`
 * resolves `POSTGRES_*` at module load and would otherwise capture the local default.
 */
async function startSweeping(): Promise<void> {
  try {
    const { prisma } = await import("./store/prisma.ts");
    const { startOfflineSweep } = await import("./agents/sweep.ts");
    startOfflineSweep(prisma);
  } catch (error) {
    console.warn(`could not start the offline sweep: ${error instanceof Error ? error.message : String(error)}`);
  }
}
