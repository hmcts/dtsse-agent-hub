/**
 * A person's schedule for their virtual agents: when the hub starts the Assistant for them and how long it waits
 * before shutting one down for being idle. Pure, so the allowed values are one list shared by the form that offers them,
 * the store that refuses everything else and the sweep that acts on them.
 */

/** Auto start does not begin before this: AAT comes up at 07:00, and the hub is not running to start anything before. */
const FIRST_AUTO_START_MINUTE = 7 * 60 + 30;

/** The last slot is the one before the evening stop's default of 19:00; a start at or after it would be stopped at once. */
const LAST_AUTO_START_MINUTE = 18 * 60 + 30;

/** How long after its time an auto start may still happen, so a sweep that was down or late for a minute does not skip a day. */
export const AUTO_START_WINDOW_MINUTES = 30;

const AUTO_START_STEP_MINUTES = 30;

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Every time an agent can be started at, as UK wall-clock `HH:MM`, in order. */
export const AUTO_START_TIMES: readonly string[] = Array.from(
  { length: (LAST_AUTO_START_MINUTE - FIRST_AUTO_START_MINUTE) / AUTO_START_STEP_MINUTES + 1 },
  (_, slot) => clock(FIRST_AUTO_START_MINUTE + slot * AUTO_START_STEP_MINUTES)
);

/** What the form sends for no auto start. Stored as no value at all. */
export const NO_AUTO_START = "none";

export function isAutoStartTime(value: unknown): value is string {
  return typeof value === "string" && AUTO_START_TIMES.includes(value);
}

/** `HH:MM` as a wall clock. Only for a value `isAutoStartTime` accepted. */
export function wallClockOf(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

export interface IdleChoice {
  value: string;
  label: string;
  /** How long without activity before the idle rule stops the agent, or `undefined` for never. */
  minutes: number | undefined;
}

/** What a person may choose to shut their agents down after, in the order the form offers them. */
export const IDLE_CHOICES: readonly IdleChoice[] = [
  { value: "1h", label: "1 hour", minutes: 60 },
  { value: "2h", label: "2 hours", minutes: 120 },
  { value: "3h", label: "3 hours", minutes: 180 },
  { value: "4h", label: "4 hours", minutes: 240 },
  { value: "never", label: "Never", minutes: undefined }
];

/** What the form sends for the deployment's own idle period, which is offered only when none of `IDLE_CHOICES` is it. */
export const DEFAULT_IDLE = "default";

export function isIdleAfter(value: unknown): value is string {
  return typeof value === "string" && IDLE_CHOICES.some((choice) => choice.value === value);
}

/**
 * The idle period that applies, in minutes: the person's choice, the deployment's `defaultMinutes` when they have made
 * none, or `undefined` when they chose never and the idle rule leaves their agents alone.
 */
export function idleMinutesFor(stored: string | null, defaultMinutes: number): number | undefined {
  const choice = IDLE_CHOICES.find((candidate) => candidate.value === stored);
  return choice === undefined ? defaultMinutes : choice.minutes;
}

/** The choices to show for a deployment whose idle period is `defaultMinutes`: the usual ones, plus its own when it is none of them. */
export function idleOffers(defaultMinutes: number): { value: string; label: string }[] {
  const offers = IDLE_CHOICES.map(({ value, label }) => ({ value, label }));
  if (IDLE_CHOICES.some((choice) => choice.minutes === defaultMinutes)) {
    return offers;
  }
  return [{ value: DEFAULT_IDLE, label: `${defaultMinutes} minutes (default)` }, ...offers];
}

/** The choice selected for a person who has stored `stored`, or nothing: the deployment's own period, as an offer. */
export function idleSelected(stored: string | null, defaultMinutes: number): string {
  if (stored !== null) {
    return stored;
  }
  return IDLE_CHOICES.find((choice) => choice.minutes === defaultMinutes)?.value ?? DEFAULT_IDLE;
}
