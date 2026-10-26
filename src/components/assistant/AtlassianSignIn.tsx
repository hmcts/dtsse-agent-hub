"use client";

import { LoginCountdown } from "@/components/virtual-agents/LoginCountdown";
import type { LoginView } from "@/virtual-agents/logins";

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
