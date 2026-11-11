"use client";

import { useState } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { LoginCountdown } from "@/components/assistant/LoginCountdown";
import type { LoginView } from "@/virtual-agents/logins";

const INPUT =
  "min-w-0 flex-1 rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 font-plex-mono text-sm text-asst-text outline-hidden focus:border-asst-accent-line disabled:opacity-60";
const PRIMARY = "shrink-0 rounded-[9px] bg-asst-accent px-3.5 py-1.5 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover disabled:opacity-40";

/**
 * What to do for a sign-in the assistant is waiting on: a code to enter on a page, or a code to paste back. The
 * getting-ready screen and the settings' Connections list both show it under the sign-in's row.
 *
 * `collectable` is whether a code they have already pasted is still there for the pod, rather than whether they ever
 * pasted one: a code the pod never came for stops being any use after `PASTED_CODE_TTL_MS` while the sign-in itself
 * can run for the rest of the hour, and `storePastedCode` will take another — so the box comes back.
 *
 * A code just sent reads as received at once rather than when the page's refresh brings `collectable`: in between
 * the form has reset, and an empty box where the code was reads as a code that was lost. It goes on reading so while
 * the pod collects it, which clears `codeWaitingUntil`, and gives way to the box only for a code the pod left past
 * its deadline, or a new sign-in.
 */
export function SignIn({
  assistantId,
  login,
  name,
  collectable,
  paste
}: {
  assistantId: string;
  login: LoginView;
  name: string;
  collectable: boolean;
  paste: FormAction;
}) {
  const [sent, setSent] = useState<{ login: string; waiting: string | null } | null>(null);
  const identity = `${login.kind} ${login.verificationUri} ${login.expiresAt}`;
  if (sent !== null && sent.login !== identity) {
    setSent(null);
  }
  const received = sent !== null && (login.codeWaitingUntil === null || login.codeWaitingUntil === sent.waiting);
  if (login.prompt === "device_code") {
    return (
      <div className="flex flex-col gap-1.5 text-[13px] text-asst-body">
        <p>
          Open{" "}
          <a href={login.verificationUri} target="_blank" rel="noreferrer noopener" className="text-asst-accent underline">
            the {name} sign-in page
          </a>{" "}
          and enter this code <LoginCountdown expiresAt={login.expiresAt} />:
        </p>
        <p>
          <span className="sr-only">{name} code: </span>
          <code className="inline-block rounded-lg border border-asst-strong bg-asst-field px-3 py-1 font-plex-mono text-lg tracking-widest text-asst-text">
            {login.userCode}
          </code>
        </p>
        <p className="text-xs text-asst-faint">Sign in as yourself.</p>
        {/* hmcts enforces SAML single sign-on, and a token is authorised for it only if the person has an SSO session
            when they enter the code; without one the clone is refused and they are asked to do this again. */}
        {login.kind === "github" ? (
          <p className="text-xs text-asst-faint">
            First{" "}
            <a href="https://github.com/orgs/hmcts/sso" target="_blank" rel="noreferrer noopener" className="text-asst-accent underline">
              sign in to HMCTS on GitHub
            </a>
            , so the sign-in is authorised for HMCTS repositories.
          </p>
        ) : null}
      </div>
    );
  }
  if (collectable || received) {
    return (
      <p role="status" className="text-[13px] text-asst-ok">
        Got it. Your assistant is finishing signing in.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 text-[13px] text-asst-body">
      <p>
        Open{" "}
        <a href={login.verificationUri} target="_blank" rel="noreferrer noopener" className="text-asst-accent underline">
          the {name} sign-in page
        </a>
        , sign in, and paste the code it gives you <LoginCountdown expiresAt={login.expiresAt} />.
      </p>
      <ActionForm
        action={paste}
        label={`Paste the ${name} code`}
        className="flex flex-wrap items-center gap-2"
        onSuccess={() => setSent({ login: identity, waiting: login.codeWaitingUntil })}
      >
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={assistantId} />
            <input type="hidden" name="kind" value={login.kind} />
            <input
              name="code"
              type="password"
              required
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              aria-label={`${name} code`}
              className={INPUT}
            />
            <button type="submit" disabled={pending} className={PRIMARY}>
              Send
            </button>
          </>
        )}
      </ActionForm>
    </div>
  );
}
