// Installing a bundled plugin's own dependencies as the pod starts, so the first use of the plugin, by a hub job or
// by the model running its script, does not wait on an npm install. Each bundled plugin's `scripts/<name>` takes
// `deps`, which installs them under a lock and does nothing else.
import { join } from "node:path";
import type { Env } from "../env.ts";
import { installBundled, tickedBundled } from "../virtual/bundled-plugins.ts";
import type { Run } from "./lookups.ts";

/** Long enough for a first install of a plugin's dependencies on a pod's network. */
export const PREPARE_TIMEOUT_MS = 15 * 60_000;

export type PrepareDeps = {
  run: Run;
  env: Env;
  /** The cft-workspace checkout; the pod's plugin copies sit beside it. */
  workspace: string;
  /** Makes the pod's copy of a bundled plugin; a test passes one that makes it somewhere of its own. */
  install?: (name: string, workspace: string) => string;
  say?: (message: string) => void;
};

/**
 * The pod's copy of a bundled plugin's `scripts/<name>`, made on first use. Null when the owner has not ticked the
 * plugin, so a pod runs a plugin's script only for someone who asked for it.
 */
export function bundledScript(name: string, workspace: string, env: Env, install: (name: string, workspace: string) => string = installBundled): string | null {
  if (!tickedBundled(env).includes(name)) {
    return null;
  }
  return join(install(name, workspace), "scripts", name);
}

/** Runs a ticked bundled plugin's `scripts/<name> deps`. Never throws: a failure is said, and the next run of the script installs again. */
export async function prepareBundled(name: string, deps: PrepareDeps): Promise<void> {
  const say = deps.say ?? (() => {});
  try {
    const script = bundledScript(name, deps.workspace, deps.env, deps.install);
    if (script === null) {
      return;
    }
    const result = await deps.run(script, ["deps"], { env: deps.env, timeoutMs: PREPARE_TIMEOUT_MS });
    if (result.code !== 0) {
      say(`${name}: could not install the tools' dependencies (exit ${result.code}): ${result.stderr.trim().slice(-300)}`);
    }
  } catch (e) {
    say(`${name}: could not prepare the tools: ${(e as Error).message}`);
  }
}

/**
 * Runs `prepareBundled` for each of `names` in turn, so their installs do not compete with each other, and starts
 * none once `signal` has aborted. Answers, by name, a promise that settles once that plugin's install has finished,
 * failed or been skipped, which is what a job using the plugin waits on; none rejects.
 */
export function prepareEach(names: readonly string[], deps: PrepareDeps, signal?: AbortSignal): ReadonlyMap<string, Promise<void>> {
  const settled = new Map<string, Promise<void>>();
  let previous: Promise<void> = Promise.resolve();
  for (const name of names) {
    previous = previous.then(() => (signal?.aborted ? undefined : prepareBundled(name, deps)));
    settled.set(name, previous);
  }
  return settled;
}

/** Least time worth starting a job with, once the wait for its plugin's install is over. */
export const MIN_RUN_MS = 30_000;

/** Settles true once `ready` does, or false at `ms`, whichever is first; true at once when there is nothing to wait on. */
export async function readyWithin(ready: Promise<void> | undefined, ms: number): Promise<boolean> {
  if (ready === undefined) {
    return true;
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([ready.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}
