import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getPropertiesVolumeSecrets } from "@hmcts-cft/cloud-native-platform";
import { parseLayout, parseModel, parseOrdering } from "@hmcts-cft/wa-spec";
import { loadSecrets } from "../platform/secrets.ts";

/**
 * Loads a service's model, with its ordering and layout, as the next version of its spec: `yarn wa:seed <model.yaml>`,
 * which defaults to ET's example. It runs through tsx, not from `dist/`, because the spec package ships TypeScript
 * source and the image carries only the compiled CLIs. Against AAT, point `DATABASE_URL` or `POSTGRES_*` at it first.
 * It refuses when the service already has a spec, so a second run cannot add a duplicate version.
 */
const DEFAULT_MODEL = "packages/wa-spec/examples/et/model.yaml";

async function run(): Promise<number> {
  await loadSecrets((chartPath) => getPropertiesVolumeSecrets({ chartPath, failOnError: false }));
  const modelPath = resolve(process.argv[2] ?? DEFAULT_MODEL);
  const model = parseModel(readFileSync(modelPath, "utf8"));
  const documentAt = (name: string | undefined) => (name === undefined ? undefined : readFileSync(resolve(dirname(modelPath), name), "utf8"));
  const orderingText = documentAt(model.order);
  const layoutText = documentAt(model.layout);
  const ordering = orderingText === undefined ? undefined : parseOrdering(orderingText);
  const layout = layoutText === undefined ? undefined : parseLayout(layoutText);

  const { getWaSpec, saveWaSpec } = await import("../assistant/wa-builder-store.ts");
  const service = model.service.slug;
  if ((await getWaSpec(service)) !== null) {
    console.error(`wa-seed: ${service} already has a spec; edits are saved as new versions, not seeded`);
    return 1;
  }
  const { version } = await saveWaSpec({ service, model, ordering, layout, savedBy: "wa-seed" });
  console.info(`wa-seed: saved ${service} version ${version}`);
  return 0;
}

void run().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`wa-seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
);
