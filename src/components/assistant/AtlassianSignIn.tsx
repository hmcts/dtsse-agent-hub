"use client";

import { useEffect, useState } from "react";
import { LoginCountdown } from "@/components/virtual-agents/LoginCountdown";
import type { LoginView } from "@/virtual-agents/logins";

/** Where the Atlassian sign-in an export is waiting on has got to, which decides what the footer may claim. */
export type SignInStage = "live" | "renewing" | "given-up" | "none";

/**
 * A code is `live` only while it can still be used: a dead code under "Signing in to Atlassian…" is worse than
 * saying nothing, because it sends somebody off to use it.
 *
 * The clock decides as much as the state does, because neither the pod's report that it has run out of codes nor the
 * hub's sweep lands the instant a code's time is up. A `pending` login past its expiry is therefore `renewing`: the
 * pod relays another code, so one more is usually on its way, and the half-minute when it was the last code rather
 * than the next reads as the `given-up` it is about to become.
 *
 * `since` is when the export now running was asked for. There is one sign-in row per kind, so the row a finished
 * export left behind is still the row this one reads: without it, clicking Export again announces that the sign-in
 * expired and no ticket was made while the new export is in flight and nothing of the sort has happened yet. A code
 * that was already dead when this export was asked for belongs to the last one and is `none` here.
 */
export function signInStage(login: LoginView | null | undefined, now: number, since: number): SignInStage {
  if (login === null || login === undefined || login.kind !== "atlassian" || new Date(login.expiresAt).getTime() <= since) {
    return "none";
  }
  if (login.state === "expired" || login.state === "failed") {
    return "given-up";
  }
  if (login.state !== "pending") {
    return "none";
  }
  return new Date(login.expiresAt).getTime() > now ? "live" : "renewing";
}

/**
 * What the footer says about the sign-in, beside the controls, or `null` when the code itself is the thing to show.
 * `made` and `retry` let the Confluence export say the same of its page.
 */
export function signInNote(stage: SignInStage, made = "ticket", retry = "Export again"): string | null {
  if (stage === "renewing") {
    return "That code's time ran out. Your assistant is relaying a fresh one, which will replace it here.";
  }
  if (stage === "given-up") {
    return `The Atlassian sign-in expired before it was used, so no ${made} was created. ${retry} for a fresh code.`;
  }
  return null;
}

/**
 * The Atlassian sign-in the assistant needs before it can export or search, as a code to enter on a page. Its own
 * module because both exports and the search show it.
 */
export function SignInPrompt({ login }: { login: LoginView }) {
  if (login.prompt !== "device_code" || login.userCode === null) {
    return <p className="basis-full text-xs text-asst-muted">Your assistant is waiting for you to sign in to Atlassian.</p>;
  }
  return (
    <p className="basis-full text-[13px] text-asst-body">
      To finish, open{" "}
      <a href={login.verificationUri} target="_blank" rel="noreferrer noopener" className="text-asst-accent underline">
        the Atlassian sign-in page
      </a>{" "}
      and enter{" "}
      <code className="rounded-md border border-asst-strong bg-asst-field px-2 py-0.5 font-plex-mono tracking-widest text-asst-text">{login.userCode}</code>{" "}
      <LoginCountdown expiresAt={login.expiresAt} />
    </p>
  );
}

/**
 * The browser's clock, ticking each second while there is an Atlassian sign-in whose code can run out, for
 * `signInStage`: the moment a code dies is the moment to stop offering it, and nothing else on the page changes then.
 * Null until the browser has a clock, so the first render matches the server's. The Jira footer keeps its own copy.
 */
export function useSignInClock(login: LoginView | null | undefined): number | null {
  const watching = login?.kind === "atlassian";
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!watching) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [watching]);
  return now;
}
