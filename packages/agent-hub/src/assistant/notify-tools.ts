// The client declares no runtime dependency (bin.test.ts), so its Notify support is loaded only when it is used, from
// the @hmcts-cft/notify-tools installed beside it: the pod image installs notify-tools globally into the same prefix as
// the agent-hub client, which is how the client finds it. A machine without it is told how to get it rather than failing to start.
import { PodJobError } from "./pod-jobs.ts";

export const TOOLS_MISSING =
  "GOV.UK Notify support comes from @hmcts-cft/notify-tools 0.1.0 or later, which is not installed beside agent-hub here. Install or update it with npm install -g --@hmcts-cft:registry=https://pkgs.dev.azure.com/hmcts/Artifacts/_packaging/hmcts-lib/npm/registry/ @hmcts-cft/notify-tools, then try again.";

/** The hub's limits on a version, checked before anything is sent so a template too big is refused with words rather than a 400. */
export const MAX_NAME = 500;
export const MAX_SUBJECT = 1000;
export const MAX_BODY = 40_000;
export const MAX_PREVIEW_BYTES = 120_000;

type NotifyModule = typeof import("./notify.ts");

/** `./notify.ts`, or `tools_missing` when the package it is built on is not installed, or is installed without the exports the client needs (an incompatible version). */
export async function loadNotify(load: () => Promise<NotifyModule> = () => import("./notify.ts")): Promise<NotifyModule> {
  try {
    return await load();
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const message = String((e as Error | null)?.message);
    const missing = (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") && message.includes("@hmcts-cft/notify-tools");
    const incompatible = e instanceof SyntaxError && /does not provide an export named/.test(message) && message.includes("@hmcts-cft/notify-tools");
    if (missing || incompatible) {
      throw new PodJobError("tools_missing", TOOLS_MISSING);
    }
    throw e;
  }
}
