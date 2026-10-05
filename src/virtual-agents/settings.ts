/**
 * The feature flag and the knobs of the virtual-agent sweep, read per call from the environment because the chart's
 * secrets reach `process.env` only once `instrumentation.ts` has loaded them.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export const DEFAULT_IDLE_MINUTES = 120;
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
