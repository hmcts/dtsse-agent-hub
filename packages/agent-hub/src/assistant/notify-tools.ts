// The client declares no runtime dependency (bin.test.ts), so its Notify support is loaded only when it is used, from
// the @hmcts-cft/notify-tools installed beside it: the pod image installs both globally into the one prefix, where
// Node finds one package from the other. A machine without it is told how to get it rather than failing to start.
import { PodJobError } from "./pod-jobs.ts";

export const TOOLS_MISSING =
  "GOV.UK Notify support comes from @hmcts-cft/notify-tools 0.1.0 or later, which is not installed beside agent-hub here. Install or update it with npm install -g @hmcts-cft/notify-tools, then try again.";

/** The hub's limits on a version, checked before anything is sent so a template too big is refused with words rather than a 400. */
export const MAX_NAME = 500;
export const MAX_SUBJECT = 1000;
export const MAX_BODY = 40_000;
export const MAX_PREVIEW_BYTES = 120_000;

type NotifyModule = typeof import("./notify.ts");

/** `./notify.ts`, or `tools_missing` when the package it is built on is not installed, or is too old to have its exports. */
export async function loadNotify(load: () => Promise<NotifyModule> = () => import("./notify.ts")): Promise<NotifyModule> {
  try {
    return await load();
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    const message = String((e as Error | null)?.message);
    const missing = (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") && message.includes("@hmcts-cft/notify-tools");
    const tooOld = e instanceof SyntaxError && /does not provide an export named/.test(message) && message.includes("@hmcts-cft/notify-tools");
    if (missing || tooOld) {
      throw new PodJobError("tools_missing", TOOLS_MISSING);
    }
    throw e;
  }
}
