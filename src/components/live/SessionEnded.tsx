"use client";

import { useSessionEnded } from "./HubStream";
import { signInAgainHref } from "./session";

/**
 * Only rendered once the session is found to have ended, which happens in the browser, so reading `location` here
 * never runs on the server.
 */
export function SessionEndedMessage() {
  return (
    <>
      Your session has ended.{" "}
      <a href={signInAgainHref(`${window.location.pathname}${window.location.search}`)} className="font-bold underline">
        Sign in again
      </a>
    </>
  );
}

/**
 * Across the top of every page once the session has ended: an alert, because every request the page makes now fails.
 */
export function SessionEndedBanner() {
  if (!useSessionEnded()) {
    return null;
  }
  return (
    <p role="alert" className="shrink-0 border-b border-red-800 bg-red-950 px-4 py-1 text-center text-xs text-red-200">
      <SessionEndedMessage />
    </p>
  );
}
