import { loadSecrets } from "./platform/secrets.ts";
import { startRealtime } from "./realtime/start.ts";
import { virtualAgentsEnabled } from "./virtual-agents/settings.ts";

type Platform = typeof import("@hmcts-cft/cloud-native-platform");

/**
 * The platform package, through `await import` rather than a `createRequire` shim.
 *
 * It is ESM-only and named in `serverExternalPackages`, so Node resolves it at runtime and the bundler leaves it
 * alone — which is how `cli/migrate.ts` has always reached it, with a plain static import. Next 16.4.3 answered the
 * require shim with a namespace carrying none of the named exports, and because the only caller of
 * `getPropertiesVolumeSecrets` is inside `loadSecrets`, that surfaced as a warning rather than a failure: the pod
 * kept its local Postgres default and every page that reads the database answered 500 behind a healthy `/health`.
 *
 * `import()` caches, so the two callers below share one load.
 */
function platform(): Promise<Platform> {
  return import("@hmcts-cft/cloud-native-platform");
}

export async function register(): Promise<void> {
  await readSecrets();
  await startMonitoring();
  await startRealtime();
  await startSweeping();
}

async function readSecrets(): Promise<void> {
  await loadSecrets(async (chartPath) => await (await platform()).getPropertiesVolumeSecrets({ chartPath, failOnError: false }));
}

async function startMonitoring(): Promise<void> {
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!connectionString) {
    return;
  }

  try {
    const { MonitoringService } = await platform();
    new MonitoringService(connectionString, "dtsse-agent-hub");
  } catch (error) {
    console.warn(`could not start Application Insights: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Marks silent agents offline, and expires deliveries to long-offline ones, every 30 seconds; and trims transcripts
 * to their retention and per-agent cap, and drops the bytes of Assistant uploads nothing fetched, every 10 minutes;
 * and, with virtual agents on, fails, expires and stops virtual agents every minute. Imported dynamically, after
 * `readSecrets`, because
 * `store/prisma.ts` resolves `POSTGRES_*` at module load and would otherwise capture the local default.
 */
async function startSweeping(): Promise<void> {
  try {
    const { prisma } = await import("./store/prisma.ts");
    const { startOfflineSweep } = await import("./agents/sweep.ts");
    startOfflineSweep(prisma);
    const { startTranscriptSweep } = await import("./transcripts/sweep.ts");
    startTranscriptSweep(prisma);
    const { startUploadSweep } = await import("./assistant/upload-sweep.ts");
    startUploadSweep(prisma);
    if (virtualAgentsEnabled()) {
      const { startVirtualAgentSweep } = await import("./virtual-agents/sweep.ts");
      startVirtualAgentSweep(prisma);
    }
  } catch (error) {
    console.warn(`could not start the sweeps: ${error instanceof Error ? error.message : String(error)}`);
  }
}
