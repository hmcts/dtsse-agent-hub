import type { Environment } from "../auth/settings.ts";
import { checkTargetUrl, type PinnedFetch, pinnedFetch, publicAddresses, type Resolve } from "./targets.ts";

/**
 * Whether a prototype address the setup wizard was given will work as a feedback link: first the rules every link is
 * held to (`checkTargetUrl`, `publicAddresses`), whose refusal the wizard will not go past, then one request to the
 * address itself, whose failure it reports and lets the owner carry on from, since a prototype can be down for a
 * minute or answer a HEAD badly and still be the right address.
 */

export type ProbeOutcome =
  /** Answered with a page, or a redirect on its own origin. */
  | { result: "pass"; status: number; reason: string }
  /** Reachable or not, the hub could serve it; something about the answer is worth the owner's eye. */
  | { result: "warn"; status: number | null; reason: string }
  /** No link may point here. */
  | { result: "refused"; reason: string };

export const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeDependencies {
  /** Connects only to the addresses `publicAddresses` passed. */
  fetch: PinnedFetch;
  publicAddresses: Resolve;
  env: Environment;
  timeoutMs: number;
}

const resolveFresh: Resolve = (hostname) => publicAddresses(hostname);

const probeFetch = pinnedFetch(resolveFresh);

const defaults = (): ProbeDependencies => ({
  fetch: probeFetch,
  publicAddresses: resolveFresh,
  env: process.env,
  timeoutMs: PROBE_TIMEOUT_MS
});

function redirectReason(location: string | null, origin: string, base: URL): ProbeOutcome {
  if (location === null || !URL.canParse(location, base)) {
    return { result: "warn", status: 302, reason: "it redirects without saying where to" };
  }
  const target = new URL(location, base);
  return target.origin === origin
    ? { result: "pass", status: 302, reason: `it redirects to ${target.pathname}, which reviewers will follow` }
    : {
        result: "warn",
        status: 302,
        reason: `it redirects to ${target.origin}, another site, which a feedback link does not follow; link to where it ends up instead`
      };
}

export async function probeTarget(value: string, overrides: Partial<ProbeDependencies> = {}): Promise<ProbeOutcome> {
  const deps = { ...defaults(), ...overrides };
  const checked = checkTargetUrl(value, deps.env);
  if (!checked.ok) {
    return { result: "refused", reason: checked.reason === "not a URL" ? "that is not a web address" : `the address ${checked.reason}` };
  }
  if ((await deps.publicAddresses(checked.hostname)).length === 0) {
    return { result: "refused", reason: "the address does not resolve to the public internet" };
  }
  const ask = async (method: "HEAD" | "GET"): Promise<Response> => {
    const response = await deps.fetch(checked.url, { method, redirect: "manual", signal: AbortSignal.timeout(deps.timeoutMs) });
    // Nothing of the body is wanted; only that the prototype answered.
    await response.body?.cancel();
    return response;
  };
  let response: Response;
  try {
    response = await ask("HEAD");
    if (response.status === 405 || response.status === 501) {
      response = await ask("GET");
    }
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      result: "warn",
      status: null,
      reason: timedOut ? `it did not answer within ${deps.timeoutMs / 1000} seconds` : "it could not be reached from the hub"
    };
  }
  const status = response.status;
  if (status >= 300 && status < 400) {
    return { ...redirectReason(response.headers.get("location"), checked.origin, checked.url), status } as ProbeOutcome;
  }
  if (status === 401 || status === 403) {
    return { result: "warn", status, reason: `it asks for a sign-in (${status}); reviewers will be asked for the prototype's password` };
  }
  if (status >= 400) {
    return { result: "warn", status, reason: `it answered ${status}, so check the address` };
  }
  return { result: "pass", status, reason: `it answered ${status}` };
}
