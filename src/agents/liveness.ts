/** An agent silent for longer than this is marked offline by the sweep. */
export const OFFLINE_AFTER_SECONDS = 90;

/**
 * How long a direct message waits for an offline agent before the sweep marks it `expired`. Every session registers a
 * new agent, so a message to one that has ended would otherwise stay queued for good; a day is long enough for a
 * laptop left asleep overnight to come back and still receive it.
 */
export const EXPIRE_AFTER_SECONDS = 24 * 60 * 60;
