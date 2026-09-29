/**
 * Opens the pod's LISTEN connection at boot rather than on the first stream. `instrumentation.ts` calls this after
 * the secrets load, because the connection string is assembled from the mounted `POSTGRES_*`; `process.ts` is
 * imported dynamically so nothing resolves it sooner.
 */
export async function startRealtime(load: () => Promise<{ realtime: () => unknown }> = () => import("./process.ts")): Promise<void> {
  try {
    const { realtime } = await load();
    realtime();
  } catch (error) {
    console.warn(`could not start the realtime listener: ${error instanceof Error ? error.message : String(error)}`);
  }
}
