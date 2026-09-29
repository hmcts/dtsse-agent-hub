import { getPropertiesVolumeSecrets } from "@hmcts-cft/cloud-native-platform";
import { loadSecrets } from "../platform/secrets.ts";

/** The image's first command: load the secrets, then apply pending migrations, then exit so the server can start. */
async function run(): Promise<number> {
  await loadSecrets((chartPath) => getPropertiesVolumeSecrets({ chartPath, failOnError: false }));

  // Imported after the secrets load, because it resolves `POSTGRES_*` when it connects.
  const { migrate } = await import("../store/migrate.ts");
  try {
    const applied = await migrate();
    console.info(applied.length === 0 ? "migrations: nothing to apply" : `migrations: applied ${applied.join(", ")}`);
    return 0;
  } catch (error) {
    console.error(`migrations failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

void run().then((code) => {
  process.exitCode = code;
});
