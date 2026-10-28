/**
 * The feature flag and the knobs of the virtual-agent sweep, read per call from the environment because the chart's
 * secrets reach `process.env` only once `instrumentation.ts` has loaded them.
 */

import { DEFAULT_PUBLIC_DOMAIN } from "./ports.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_IDLE_MINUTES = 120;
/**
 * Far shorter than the idle period because the agent is not idle, it is blocked: someone who is going to enter a
 * device code does it in minutes, and a device code lives 15, so half an hour is two codes' worth of patience. Past
 * that nobody is coming, and the pod is holding a node to hand out codes to an empty room.
 */
export const DEFAULT_AWAITING_OWNER_MINUTES = 30;
export const DEFAULT_EVENING_STOP = "19:00";
export const DEFAULT_DISK_TTL_DAYS = 14;
export const DEFAULT_ORCHESTRATOR_LEASE_SECONDS = 120;

export class VirtualAgentConfigurationError extends Error {}

/** Off unless set to exactly `true`: with it off the UI hides virtual agents and their routes answer 404. */
export function virtualAgentsEnabled(env: Environment = process.env): boolean {
  return env.VIRTUAL_AGENTS_ENABLED === "true";
}

function positiveWhole(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new VirtualAgentConfigurationError(`${name} must be a whole number of at least 1`);
  }
  return Number(raw);
}

export function idleMinutes(env: Environment = process.env): number {
  return positiveWhole(env, "VIRTUAL_AGENT_IDLE_MINUTES", DEFAULT_IDLE_MINUTES);
}

/** How long an agent waiting on its owner, for a sign-in or a credential, waits before the sweep stops it. */
export function awaitingOwnerMinutes(env: Environment = process.env): number {
  return positiveWhole(env, "VIRTUAL_AGENT_AWAITING_OWNER_MINUTES", DEFAULT_AWAITING_OWNER_MINUTES);
}

export function diskTtlDays(env: Environment = process.env): number {
  return positiveWhole(env, "VIRTUAL_AGENT_DISK_TTL_DAYS", DEFAULT_DISK_TTL_DAYS);
}

/** How long the orchestrator lease outlives its holder's last claim before another cluster may take it. */
export function orchestratorLeaseSeconds(env: Environment = process.env): number {
  return positiveWhole(env, "ORCHESTRATOR_LEASE_SECONDS", DEFAULT_ORCHESTRATOR_LEASE_SECONDS);
}

export interface WallClock {
  hour: number;
  minute: number;
}

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `VIRTUAL_AGENT_EVENING_STOP`, a UK wall-clock time as `HH:MM`. */
export function eveningStop(env: Environment = process.env): WallClock {
  const raw = env.VIRTUAL_AGENT_EVENING_STOP?.trim() || DEFAULT_EVENING_STOP;
  const match = HH_MM.exec(raw);
  if (match === null) {
    throw new VirtualAgentConfigurationError("VIRTUAL_AGENT_EVENING_STOP must be a 24-hour time as HH:MM");
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The object ids of the orchestrator's app registrations, from `ORCHESTRATOR_OIDS`. */
export function orchestratorOids(env: Environment = process.env): string[] {
  return (env.ORCHESTRATOR_OIDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/**
 * The app role an orchestrator's token must carry, from `ORCHESTRATOR_ROLE`, or `null` when it is unset and no role
 * is required: central-app-registration cannot assign an app role to a managed identity, so the deployed orchestrator
 * is trusted by its `oid` alone.
 */
export function orchestratorRole(env: Environment = process.env): string | null {
  const role = env.ORCHESTRATOR_ROLE?.trim();
  return role || null;
}

/** The domain each reported port's host is under; the orchestrator reads the same variable for its Ingress hosts. */
export function publicDomain(env: Environment = process.env): string {
  return env.VIRTUAL_AGENT_PUBLIC_DOMAIN?.trim() || DEFAULT_PUBLIC_DOMAIN;
}

/**
 * What a pod on the `gateway` route needs to reach the HMCTS AI Gateway, as a claim carries it to the orchestrator.
 *
 * Two credentials, not one: a token per person, which the pod mints from the owner's own `az` sign-in, and an APIM
 * subscription key per service, which is this. Named as the claim's JSON, since that is the only thing that reads it.
 */
export interface GatewaySettings {
  /** The gateway's origin; the pod appends the Bedrock passthrough path itself. */
  base_url: string;
  /** The Entra scope `az` is asked for a token for. A wrong one is a bare `401 invalid_token` at the gateway. */
  audience: string;
  /** The APIM subscription key, sent as `Ocp-Apim-Subscription-Key`. */
  apim_key: string;
}

/**
 * An Entra client-credentials scope: an Application ID URI and `/.default`.
 *
 * The characters are a conservative allow-list rather than "anything but whitespace", because the pod interpolates
 * this value into a double-quoted shell string in its token helper, where a quote, a backtick or a `$(…)` would run
 * as the pod's user. An Application ID URI holds a scheme, a host or a GUID and a path, so none of them is needed;
 * the entrypoint refuses the same set again, since this hub is not the only thing that can set a pod's environment.
 */
const GATEWAY_SCOPE = /^api:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]*\/\.default$/;

function httpOrigin(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_AUDIENCE` and `AI_GATEWAY_APIM_KEY`, all three or none, or `null` for a
 * deployment with no gateway configured — which simply has no working `gateway` route, and is fine until somebody is
 * put on one.
 *
 * Half of them is refused here rather than at the first model call, because that is a pod that boots and then fails
 * every turn. Refused by throwing, as every other setting in this file is: the claim is the one caller, and a claim
 * that answered 500 is an orchestrator retrying a pass against a deployment nobody has finished configuring, which
 * is the loudest the hub can be about it without failing agents that have nothing to do with the gateway.
 *
 * The key is never named in the message, since a `VirtualAgentConfigurationError` is logged and answered with.
 */
export function gatewaySettings(env: Environment = process.env): GatewaySettings | null {
  const baseUrl = env.AI_GATEWAY_BASE_URL?.trim() || undefined;
  const audience = env.AI_GATEWAY_AUDIENCE?.trim() || undefined;
  const apimKey = env.AI_GATEWAY_APIM_KEY?.trim() || undefined;
  if (baseUrl === undefined && audience === undefined && apimKey === undefined) {
    return null;
  }
  const problems: string[] = [];
  if (baseUrl === undefined || !httpOrigin(baseUrl)) {
    problems.push("AI_GATEWAY_BASE_URL must be the gateway's http or https origin, as https://ai-gateway.sandbox.platform.hmcts.net");
  }
  if (audience === undefined || !GATEWAY_SCOPE.test(audience)) {
    problems.push("AI_GATEWAY_AUDIENCE must be the gateway's Entra scope, as api://<client id>/.default");
  }
  if (apimKey === undefined) {
    problems.push("AI_GATEWAY_APIM_KEY is not set: the gateway needs an APIM subscription key as well as a token");
  }
  if (problems.length > 0) {
    throw new VirtualAgentConfigurationError(`the AI Gateway is half configured: ${problems.join("; ")}`);
  }
  // The pod appends the Bedrock passthrough path, so a trailing slash would make a double one at the gateway.
  return { base_url: baseUrl!.replace(/\/+$/, ""), audience: audience!, apim_key: apimKey! };
}
