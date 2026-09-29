import type { Environment } from "../store/database-url.ts";
import { describeDatabase } from "./database-target.ts";

/** The variable that asks for the deployed secrets outside production, and has to be set on purpose. */
export const KEY_VAULT_OPT_IN = "USE_KEY_VAULT";

export const CHART_PATH = "./charts/dtsse-agent-hub/values.yaml";

/** The platform call, injected so this module can be tested without a vault. */
export type ReadSecrets = (chartPath: string) => Promise<unknown>;

/**
 * Whether this process may read the Key Vault. Fails local: a laptop with an `az login` session would otherwise
 * attach `yarn dev` to the AAT database. The runtime image sets `NODE_ENV=production`, so pods always read it.
 */
export function keyVaultAllowed(env: Environment = process.env): boolean {
  return env.NODE_ENV === "production" || env[KEY_VAULT_OPT_IN] === "true";
}

/**
 * Loads the deployed secrets where allowed, then logs which database the process ended up with. Awaited before
 * any module that reads `POSTGRES_*` is imported.
 */
export async function loadSecrets(read: ReadSecrets, env: Environment = process.env): Promise<void> {
  if (keyVaultAllowed(env)) {
    try {
      await read(CHART_PATH);
    } catch (error) {
      console.warn(`could not load Key Vault secrets: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.info(`not reading the Key Vault: NODE_ENV is ${env.NODE_ENV ?? "unset"} and ${KEY_VAULT_OPT_IN}=true is not set, so the local defaults apply`);
  }

  console.info(`database: ${describeDatabase(env)}`);
}
