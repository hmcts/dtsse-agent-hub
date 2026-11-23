/**
 * A save made in this tab refreshes the page itself and is then announced to every tab, this one included. The editor
 * notes its save here, and the first announcement within `ECHO_MS` is taken as that save's echo, so the page is not
 * refreshed a second time for a change it already shows.
 */

/** Long enough for the stream to deliver the announcement, short enough that another tab's save soon after is not mistaken for it. */
export const ECHO_MS = 3000;

let savedAt: number | null = null;

export function noteOwnSave(now: number = Date.now()): void {
  savedAt = now;
}

/** Whether an announcement arriving at `now` is the echo of this tab's own save, which it uses up. */
export function takeOwnEcho(now: number = Date.now()): boolean {
  const echo = savedAt !== null && now - savedAt <= ECHO_MS;
  savedAt = null;
  return echo;
}
