import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPropertiesVolumeSecrets } from "@hmcts-cft/cloud-native-platform";
import { modelLayoutPath, orderPathFor, parseLayout, parseModel, parseOrdering } from "@hmcts-cft/wa-spec";
import { loadSecrets } from "../platform/secrets.ts";

/**
 * Loads a service's model, with the ordering and layout it names or has beside it, as version 1 of its spec:
 * `yarn wa:seed <model.yaml>`, which defaults to ET's example. It runs through tsx, not from `dist/`, because the spec
 * package ships TypeScript source and the image carries only the compiled CLIs. Against AAT, point `DATABASE_URL` or
 * `POSTGRES_*` at it first. It refuses when the service already has a spec.
 */
const readText = (path: string): string => readFileSync(path, "utf8"); // NOSONAR: a path the operator passed

const DEFAULT_MODEL = fileURLToPath(new URL("../../packages/wa-spec/examples/et/model.yaml", import.meta.url));

async function run(): Promise<number> {
  await loadSecrets((chartPath) => getPropertiesVolumeSecrets({ chartPath, failOnError: false }));
  const argument = process.argv[2];
  const modelPath = argument === undefined ? DEFAULT_MODEL : resolve(process.env.INIT_CWD ?? process.cwd(), argument);
  const model = parseModel(readText(modelPath));
  const orderPath = orderPathFor(modelPath, model);
  const layoutPath = modelLayoutPath(modelPath, model);
  const ordering = orderPath === undefined ? undefined : parseOrdering(readText(orderPath));
  const layout = layoutPath === undefined ? undefined : parseLayout(readText(layoutPath));

  const { prisma } = await import("../store/prisma.ts");
  const { saveWaSpec } = await import("../assistant/wa-builder-store.ts");
  const { WaVersionConflict } = await import("../assistant/wa-builder.ts");
  const service = model.service.slug;
  try {
    const { version } = await saveWaSpec(prisma, { service, model, ...(ordering && { ordering }), ...(layout && { layout }), savedBy: "wa-seed", basedOn: 0 });
    console.info(`wa-seed: saved ${service} version ${version}`);
    return 0;
  } catch (error) {
    if (error instanceof WaVersionConflict) {
      console.error(`wa-seed: ${service} already has a spec; edits are saved as new versions, not seeded`);
      return 1;
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// The pool keeps idle connections for 30s, which $disconnect does not end, so the process is ended rather than waited on.
void run().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    console.error(`wa-seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
);
