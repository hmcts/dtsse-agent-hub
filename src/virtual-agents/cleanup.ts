import type { WallClock } from "./settings.ts";

/**
 * When the sweep acts on a virtual agent, as pure functions of the clock so they are tested without waiting.
 */

/** A pod that has said nothing for this long since it was scheduled is not going to. */
export const PROVISIONING_TIMEOUT_MS = 15 * 60_000;

/** An orchestrator that has not reported on a claim for this long has died, so another may take it. */
export const CLAIM_TIMEOUT_MS = 2 * 60_000;

/** How long a pasted login code waits for the pod to fetch it. */
export const PASTED_CODE_TTL_MS = 10 * 60_000;

/** The UI warns that a stopped agent's disk will be deleted from this many days before. */
export const DISK_WARNING_DAYS = 3;

const DAY_MS = 24 * 60 * 60_000;

const ZONE = "Europe/London";

const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23"
});

interface LondonParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function londonParts(at: Date): LondonParts {
  const parts = LONDON.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((candidate) => candidate.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}

/** How far UK wall-clock time is ahead of UTC at `at`: an hour in BST, nothing in GMT. */
function londonOffsetMs(at: Date): number {
  const parts = londonParts(at);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant UK clocks read `hour:minute` on that date. Corrected twice because the offset is that of the answer,
 * not of the guess; the clocks change at 01:00 UTC, so any evening time has exactly one answer.
 */
export function londonInstant(year: number, month: number, day: number, { hour, minute }: WallClock): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - londonOffsetMs(new Date(wall));
  return new Date(wall - londonOffsetMs(new Date(first)));
}

/**
 * The most recent weekday evening stop at or before `now`, in UK time. An agent started before it is stopped by the
 * sweep; one started after it, by someone working late, runs until the next one.
 */
export function latestEveningStop(now: Date, stop: WallClock): Date {
  const today = londonParts(now);
  for (let back = 0; ; back += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day - back));
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) {
      continue;
    }
    const cutoff = londonInstant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), stop);
    if (cutoff.getTime() <= now.getTime()) {
      return cutoff;
    }
  }
}

/** Whether an agent started at `startedAt` is due its evening stop at `now`. */
export function dueEveningStop(startedAt: Date, now: Date, stop: WallClock): boolean {
  return startedAt.getTime() < latestEveningStop(now, stop).getTime();
}

/** The latest of the times that show the agent doing something, or `undefined` when there are none. */
export function lastActivity(...times: (Date | null | undefined)[]): Date | undefined {
  let latest: Date | undefined;
  for (const time of times) {
    if (time !== null && time !== undefined && (latest === undefined || time.getTime() > latest.getTime())) {
      latest = time;
    }
  }
  return latest;
}

/**
 * Whether a running agent has been idle long enough to stop. A busy linked agent is working whatever the clock says;
 * otherwise the latest sign of activity has to be older than the idle period.
 */
export function isIdle(linkedStatus: string | null, lastActiveAt: Date, now: Date, idleMinutes: number): boolean {
  return linkedStatus !== "busy" && now.getTime() - lastActiveAt.getTime() >= idleMinutes * 60_000;
}

export function provisioningTimedOut(lastHeardAt: Date, now: Date): boolean {
  return now.getTime() - lastHeardAt.getTime() >= PROVISIONING_TIMEOUT_MS;
}

export function diskExpiresAt(stoppedAt: Date, ttlDays: number): Date {
  return new Date(stoppedAt.getTime() + ttlDays * DAY_MS);
}

/** Whole days left before a stopped agent's disk is deleted, when that is within the warning period; else `undefined`. */
export function diskWarningDays(expiresAt: Date | null, now: Date): number | undefined {
  if (expiresAt === null) {
    return undefined;
  }
  const left = expiresAt.getTime() - now.getTime();
  if (left > DISK_WARNING_DAYS * DAY_MS) {
    return undefined;
  }
  return Math.max(0, Math.ceil(left / DAY_MS));
}
