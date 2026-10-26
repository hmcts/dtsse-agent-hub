"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CONNECTION_DETAILS,
  type ConnectionsPrompt,
  type Connector,
  connectionState,
  connections,
  connectionsPrompt,
  hasLapsed,
  offeredConnections,
  signInPrompt
} from "@/assistant/connections";
import { type ConnectionsAsk, connectionsAsk } from "@/assistant/onboarding";
import type { Theme } from "@/assistant/theme";
import type { AssistantSummary } from "@/assistant/views";
import { waitingCookie } from "@/assistant/waiting";
import {
  firstWarmupMessage,
  nextWarmupMessage,
  WARMUP_PATIENCE_MS,
  WARMUP_ROTATE_MS,
  WARMUP_SIGNPOST,
  WARMUP_SLOW,
  type WarmupPhase,
  waitingForPerson,
  warmupPhase
} from "@/assistant/warmup";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Mark } from "@/components/assistant/AssistantShell";
import { useVisit } from "@/components/assistant/AssistantVisit";
import { ThemeSwitch } from "@/components/assistant/ThemeSwitch";
import { LoginCountdown } from "@/components/virtual-agents/LoginCountdown";
import { checklistState } from "@/components/virtual-agents/OnboardingChecklist";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { LoginView } from "@/virtual-agents/logins";

const INPUT =
  "min-w-0 flex-1 rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 font-plex-mono text-sm text-asst-text outline-none focus:border-asst-accent-line";
const PRIMARY = "shrink-0 rounded-[9px] bg-asst-accent px-3.5 py-1.5 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover";
const FOOTER = "h-[42px] rounded-[10px] px-5 text-sm";
const FOOTER_PRIMARY = `${FOOTER} bg-asst-accent font-semibold text-asst-ink disabled:opacity-40`;
const FOOTER_QUIET = `${FOOTER} border border-asst-strong font-medium text-asst-body hover:bg-asst-active`;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** False until the browser has taken the page over, so a decision needing its clock is not made in a server render. */
function useTicked(): boolean {
  const [ticked, setTicked] = useState(false);
  useEffect(() => {
    setTicked(true);
  }, []);
  return ticked;
}

/**
 * The line that rotates while the assistant starts. The first one is the phase's first message, not a random one,
 * because the server renders this too and a random choice would not survive hydration; the picking begins once the
 * browser has taken over.
 *
 * `since` is when the assistant last changed what it is doing, so how long the wait has gone on is measured from the
 * wait itself rather than from this screen's mount. Someone who navigates between pages, or sends the screen away
 * and opens it again, is still waiting on the same step, and must not be told it usually takes a couple of minutes
 * for a step that has already taken ten.
 */
function useWarmupMessage(phase: WarmupPhase, rotating: boolean, since: number): { message: string; slow: boolean } {
  // Keyed to the phase as well as held, so the pod moving on to the next step changes the line with the step beside
  // it rather than at the next tick: "Preparing your workspace…" must not sit under "Putting the kettle on.".
  const [shown, setShown] = useState(() => ({ phase, message: firstWarmupMessage(phase) }));
  if (shown.phase !== phase) {
    setShown({ phase, message: firstWarmupMessage(phase) });
  }
  const message = shown.phase === phase ? shown.message : firstWarmupMessage(phase);
  // The server renders this too and its clock is not the browser's, so `slow` waits for the browser's: a wait
  // crossing three minutes between the two renders would otherwise send the joke and hydrate the other line. The
  // cost is that a screen opening on a wait already past three minutes shows a joke for one frame.
  const ticked = useTicked();
  const now = useNow();
  const slow = ticked && rotating && now - since >= WARMUP_PATIENCE_MS;
  useEffect(() => {
    if (!rotating || slow) {
      return;
    }
    const timer = setInterval(
      () => setShown((previous) => ({ phase: previous.phase, message: nextWarmupMessage(previous.phase, previous.message, Math.random()) })),
      WARMUP_ROTATE_MS
    );
    return () => clearInterval(timer);
  }, [rotating, slow]);
  return { message, slow };
}

/** What to do for a sign-in the assistant is waiting on: a code to enter on a page, or a code to paste back. */
function SignIn({ assistantId, login, name, paste }: { assistantId: string; login: LoginView; name: string; paste: FormAction }) {
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
      </div>
    );
  }
  if (login.codeWaiting) {
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
      <ActionForm action={paste} label={`Paste the ${name} code`} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={assistantId} />
        <input type="hidden" name="kind" value={login.kind} />
        <input name="code" type="password" required autoComplete="off" spellCheck={false} aria-label={`${name} code`} className={INPUT} />
        <button type="submit" className={PRIMARY}>
          Send
        </button>
      </ActionForm>
    </div>
  );
}

/**
 * The way back from a sign-in the assistant cannot finish on its own: the stored credential goes and the assistant
 * restarts, so its pod finds none and relays a fresh code. The only thing a person can do about a credential their
 * pod has already failed to use — nothing on this screen can mend the stored value, and waiting does not either,
 * because the pod asks again only when it next starts.
 *
 * The consequence is said beside the button rather than behind a confirmation, because this row is only ever offered
 * for a sign-in that has already stopped working: there is nothing here to lose.
 */
function SignInAgain({ assistantId, kind, name, reconnect }: { assistantId: string; kind: CredentialKind; name: string; reconnect: FormAction }) {
  return (
    <div className="flex flex-col gap-1.5 text-[13px] text-asst-body">
      <p>Your assistant could not use your saved {name} sign-in. Signing in again restarts it; your chats are kept.</p>
      <ActionForm action={reconnect} label={`Sign in to ${name} again`} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={assistantId} />
        <input type="hidden" name="kind" value={kind} />
        <button type="submit" className={PRIMARY}>
          Sign in again
        </button>
      </ActionForm>
    </div>
  );
}

function ConnectionRow({
  kind,
  connector,
  status,
  login,
  assistantId,
  starting,
  paste,
  save,
  reconnect,
  now,
  first
}: {
  kind: CredentialKind;
  connector: Connector;
  status: CredentialStatus | undefined;
  login: LoginView | undefined;
  assistantId: string;
  starting: boolean;
  paste: FormAction;
  save: FormAction;
  reconnect: FormAction;
  now: number;
  first: boolean;
}) {
  const [connecting, setConnecting] = useState(false);
  const answer = checklistState(status?.stored === true, login, now);
  const state = connectionState(answer, login, status);
  // What the person pastes to connect this one, or `null` when their assistant signs in and relays a code. The
  // connector's own answer, so a kind with no sign-in behind it is never offered a note about one never coming.
  const pasted = connector.paste;
  // A stored sign-in the assistant made for itself and has since failed to use, which is the one case the row has an
  // action of its own for: nothing here can mend a stored value, and the pod asks again only when it next starts.
  // Anything the person pastes keeps offering its box, and a lapsed sign-in with nothing stored is one the pod still
  // needs and will ask for again by itself.
  const again = hasLapsed(state) && pasted === null && status?.stored === true;
  let right: React.ReactNode;
  if (state === "connected") {
    right = <span className="shrink-0 text-[13px] font-medium text-asst-ok">✓ Connected</span>;
  } else if (again) {
    right = <span className="shrink-0 text-[13px] text-asst-warn">{CONNECTION_DETAILS[state]}</span>;
  } else if (answer === "login" || (!pasted && (connecting || starting))) {
    right = <span className="shrink-0 text-[13px] text-asst-accent-soft">{answer === "login" ? "Waiting for you" : "Connecting…"}</span>;
  } else {
    right = (
      <button
        type="button"
        onClick={() => setConnecting(true)}
        className="h-[34px] shrink-0 rounded-[9px] border border-asst-accent-line px-3.5 text-[13px] font-medium text-asst-accent-soft hover:bg-asst-accent hover:text-asst-ink"
      >
        Connect
      </button>
    );
  }
  // One thing to do at a time, chosen here rather than by three conditions that have to agree: a relayed sign-in and
  // a field for the same credential, side by side, is two password boxes posting to different places, and a token
  // typed into the code box reaches the pod and comes back only as a sign-in that did not work.
  let below: React.ReactNode = null;
  if (answer === "login" && login !== undefined) {
    // The live sign-in wins over anything the person clicked before it arrived, which on the Claude row is the usual
    // order: they ask to connect, and the pod relays its code a moment later.
    below = <SignIn assistantId={assistantId} login={login} name={connector.name} paste={paste} />;
  } else if (again) {
    below = <SignInAgain assistantId={assistantId} kind={kind} name={connector.name} reconnect={reconnect} />;
  } else if (state !== "connected" && connecting && pasted !== null) {
    below = (
      <ActionForm action={save} label={`Save your ${pasted}`} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="kind" value={kind} />
        <input name="value" type="password" required autoComplete="off" spellCheck={false} aria-label={pasted} className={INPUT} />
        <button type="submit" className={PRIMARY}>
          Save
        </button>
      </ActionForm>
    );
  } else if (state !== "connected" && connecting) {
    below = <p className="text-xs text-asst-faint">Your assistant asks for this as it starts. The sign-in will appear here.</p>;
  }
  return (
    <li className={`flex flex-col gap-2.5 bg-asst-bg px-4 py-3.5 ${first ? "" : "border-t border-asst-line"}`}>
      <div className="flex items-center gap-3.5">
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-asst-active text-sm font-semibold">
          {connector.initial}
        </span>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-[15px] font-medium">{connector.name}</span>
          <span className="text-[13px] text-asst-muted">{connector.desc}</span>
        </div>
        {right}
      </div>
      {below}
      {hasLapsed(state) && !again ? (
        <p role="alert" className="text-xs text-asst-error">
          That sign-in did not work. Your assistant will ask again.
        </p>
      ) : null}
    </li>
  );
}

/**
 * What the screen says it is for. The `unknown` line neither claims the person has connected anything nor asks them
 * to: the hub has not read their credentials, and someone who has signed in everywhere must not be told otherwise.
 */
function subtitleFor(ask: ConnectionsAsk, returning: boolean): string {
  if (ask === "unknown") {
    return "Your sign-ins cannot be checked just now, so your assistant may ask you for one as it goes.";
  }
  return returning
    ? "Your assistant is waiting for you to sign in again before it can carry on."
    : "While it gets ready, connect the tools it needs to work with your repos, tickets and pipelines.";
}

/** The footer button, which leaves rather than blocks unless there is something the person can actually connect. */
function continueLabel(ask: ConnectionsAsk, returning: boolean): string {
  if (ask === "unknown") {
    return "Carry on";
  }
  if (ask === "connect") {
    return "Connect the accounts above to continue";
  }
  return returning ? "Carry on without waiting" : "Start chatting";
}

/** What the appearance switch and the heading need, whichever of the two getting-ready screens is showing. */
interface ScreenProps {
  assistant: AssistantSummary;
  unavailable: string | null;
  /** The appearance the person chose; the screen offers the switch, since it covers the sidebar's. */
  theme?: Theme;
}

/** The shell both getting-ready screens share: the mark, the heading, how far the assistant has got, and why not. */
function ReadyShell({ assistant, unavailable, theme = "system", subtitle, children }: ScreenProps & { subtitle?: string; children: React.ReactNode }) {
  const { readiness } = assistant;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="getting-ready-title"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-asst-rail p-6 font-plex text-[15px] text-asst-text"
    >
      <div className="absolute right-4 top-4">
        <ThemeSwitch initial={theme} />
      </div>
      <div className="flex w-full max-w-[480px] flex-col gap-7">
        <div className="flex flex-col items-start gap-4">
          <Mark size="lg" />
          <div className="flex flex-col gap-1.5">
            <h1 id="getting-ready-title" className="text-[26px] font-medium tracking-tight">
              {readiness.ready ? "Your assistant is ready" : readiness.failed ? "Your assistant could not start" : "Your assistant is getting ready"}
            </h1>
            {subtitle === undefined ? null : <p className="text-pretty text-asst-muted">{subtitle}</p>}
          </div>
          <div className="flex w-full flex-col gap-1.5">
            <div
              role="progressbar"
              aria-label="Getting your assistant ready"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={readiness.percent}
              className="h-1 w-full overflow-hidden rounded bg-asst-active"
            >
              <div className="h-full rounded bg-asst-accent transition-[width] duration-300" style={{ width: `${readiness.percent}%` }} />
            </div>
            <p role="status" className="font-plex-mono text-xs text-asst-faint">
              {readiness.step}
            </p>
            {readiness.failed && assistant.statusDetail ? <p className="text-xs text-asst-error">{assistant.statusDetail}</p> : null}
          </div>
        </div>
        {unavailable === null ? null : <p className="text-sm text-asst-error">{unavailable}</p>}
        {children}
      </div>
    </div>
  );
}

/**
 * The connections and the sign-ins the assistant's pod relays as it reaches each one, so a connection shows
 * "Connecting…" until its code appears. On a first visit it is where the person connects the accounts their assistant
 * works with, opened from the connections banner while the assistant warms up behind it.
 * `returning` is the other way in — someone who connected everything on an earlier visit, whose assistant has
 * stopped to ask them to sign in again — so the screen asks for that rather than introducing the connections, and
 * its button leaves rather than finishing anything.
 *
 * `unavailable` is the third way in, and the connections are not listed at all for it: the hub has not read them,
 * so every row would say "Connect" about a sign-in that may well be there. It says why instead, and its button
 * leaves, because holding someone behind a checklist the hub cannot check is a door with no handle.
 *
 * `onLeave` is how the screen is closed while a connection is still missing, and it is why the screen may cover the
 * page at all: it is a thing the person opened from the banner and can close again, not a gate across the Assistant.
 *
 * A row whose stored credential a pod has failed to use reads as lapsed rather than connected, and offers `reconnect`:
 * nothing else on this screen can mend a stored value, so without it the one row that needs the person is the one
 * with nothing on it to press.
 */
export function GettingReady({
  assistant,
  statuses,
  unavailable,
  paste,
  save,
  reconnect,
  onDone,
  onLeave,
  returning = false,
  theme = "system"
}: ScreenProps & {
  statuses: CredentialStatus[];
  paste: FormAction;
  save: FormAction;
  reconnect: FormAction;
  onDone: () => void;
  onLeave?: () => void;
  returning?: boolean;
}) {
  const now = useNow();
  const ask = connectionsAsk(assistant.onboarded, unavailable);
  const offered = offeredConnections(assistant);
  const starting = !assistant.readiness.failed && assistant.status !== "running";
  return (
    <ReadyShell assistant={assistant} unavailable={unavailable} theme={theme} subtitle={subtitleFor(ask, returning)}>
      {ask === "unknown" ? (
        <p className="text-pretty text-asst-body">
          Whatever you have already connected is still connected — the hub just cannot read your sign-ins at the moment, so it is not listing them. There is
          nothing for you to set up again.
        </p>
      ) : (
        <ul aria-label="Connections" className="flex flex-col overflow-hidden rounded-[14px] border border-asst-line">
          {offered.map(({ kind, connector }, index) => (
            <ConnectionRow
              key={kind}
              kind={kind}
              connector={connector}
              status={statuses.find((status) => status.kind === kind)}
              login={assistant.logins.find((login) => login.kind === kind)}
              assistantId={assistant.id}
              starting={starting}
              paste={paste}
              save={save}
              reconnect={reconnect}
              now={now}
              first={index === 0}
            />
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-3">
        {/* Beside the one button that is ever disabled, so the screen they opened is never one they cannot close. */}
        {ask === "connect" && onLeave !== undefined ? (
          <button type="button" onClick={onLeave} className={FOOTER_QUIET}>
            Go to your chats
          </button>
        ) : null}
        <button type="button" onClick={onDone} disabled={ask === "connect"} className={FOOTER_PRIMARY}>
          {continueLabel(ask, returning)}
        </button>
      </div>
    </ReadyShell>
  );
}

/**
 * What the Assistant has to ask or tell someone about their connections, and the way to the screen it is about.
 *
 * A banner and not a screen over everything, because being wrong about this is not symmetric. "You must do this
 * first" is unrecoverable: it takes away the sidebar, every conversation and the settings that could fix it, over a
 * state the person may not be able to satisfy — a model route their session disagrees with, a credentials vault that
 * is down. A banner somebody scrolls past costs them only the thing they were already not doing. So the page stays
 * theirs, and the screen opens only when they ask for it.
 *
 * `onHide` is left out for an ask there is something to do about, which is the whole of a `connect`: the ask has to
 * outlast their attention, or they lose the only thing telling them why nothing works. An `unknown` has it, because
 * there is nothing for them to do and saying so once is enough.
 */
function ConnectionsBanner({ prompt, onShow, onHide }: { prompt: ConnectionsPrompt; onShow: () => void; onHide?: () => void }) {
  return (
    <div
      role="region"
      aria-label={prompt.label}
      className={`fixed left-1/2 top-[68px] z-40 flex w-[min(calc(100%-2rem),44rem)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-[12px] border border-asst-accent-line bg-asst-raised py-2.5 pl-4 font-plex text-asst-text shadow-lg ${onHide === undefined ? "pr-4" : "pr-2.5"}`}
    >
      <p className="min-w-0 flex-1 text-[13px] text-asst-body">{prompt.message}</p>
      <button
        type="button"
        onClick={onShow}
        className="shrink-0 rounded-[9px] bg-asst-accent px-3.5 py-1.5 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover"
      >
        {prompt.action}
      </button>
      {onHide === undefined ? null : (
        <button
          type="button"
          onClick={onHide}
          aria-label="Hide this message"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-asst-muted hover:bg-asst-active hover:text-asst-text"
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}
    </div>
  );
}

/**
 * A return visit to an assistant that is not running and is not waiting on the person: the same progress, with
 * nothing to do but wait, so a rotating line keeps them company and says how long this takes. Every connection is
 * made and the pod is asking for none, so they are not listed. The button leaves: an assistant that could not start
 * stays failed until a new pod starts reporting, so without one the screen would shut the person out of the hub.
 */
export function WarmingUp({ assistant, unavailable, theme = "system", onDismiss }: ScreenProps & { onDismiss: () => void }) {
  const { failed } = assistant.readiness;
  const { message, slow } = useWarmupMessage(warmupPhase(assistant.status), !failed, Date.parse(assistant.statusChangedAt));
  return (
    <ReadyShell assistant={assistant} unavailable={unavailable} theme={theme}>
      {failed ? null : (
        <div className="flex flex-col gap-1.5">
          {slow ? (
            <p className="text-pretty text-asst-muted">{WARMUP_SLOW}</p>
          ) : (
            <>
              {/* Not a live region: `readiness.step` is the one that reports progress, and this talks over it. */}
              <p aria-hidden="true" className="text-pretty text-asst-muted">
                {message}
              </p>
              <p className="text-xs text-asst-faint">{WARMUP_SIGNPOST}</p>
            </>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <button type="button" onClick={onDismiss} className={failed ? FOOTER_PRIMARY : FOOTER_QUIET}>
          {failed ? "Carry on without it" : "Carry on while it starts"}
        </button>
      </div>
    </ReadyShell>
  );
}

/**
 * What is left once the person sends the waiting screen away: the step the screen was reporting, live, so someone
 * who went off to read an old conversation is still told when their assistant comes up, and a way back to the screen
 * until it has.
 *
 * It hangs below the chat's header rather than above the composer, which owns the bottom of the page: the composer
 * centres its own error line and the guidance about checking answers and personal data there, and this must not
 * cover either of them for the length of a start.
 */
function WaitingNotice({ assistant, onShow, onHide }: { assistant: AssistantSummary; onShow: () => void; onHide: () => void }) {
  const { ready, step } = assistant.readiness;
  return (
    <div className="fixed left-1/2 top-[68px] z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-asst-line bg-asst-raised py-2 pl-4 pr-2.5 font-plex text-asst-text shadow-lg">
      <p role="status" className="min-w-0 truncate text-[13px] text-asst-body">
        {step}
      </p>
      {ready ? null : (
        <button type="button" onClick={onShow} className="shrink-0 rounded-full px-2.5 py-1 text-[13px] font-medium text-asst-accent-soft hover:bg-asst-active">
          Show progress
        </button>
      )}
      <button
        type="button"
        onClick={onHide}
        aria-label="Hide your assistant's progress"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-asst-muted hover:bg-asst-active hover:text-asst-text"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

/** Closes whichever getting-ready screen is up on Escape, which `aria-modal` leads a keyboard user to expect. */
function useEscape(active: boolean, close: () => void): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, close]);
}

/** Remembers the person's choice where a navigation cannot lose it, or forgets it when they ask to watch again. */
function rememberDismissal(assistant: AssistantSummary, dismissed: boolean): void {
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing from browsers HMCTS staff still use
  document.cookie = waitingCookie(dismissed ? assistant : null);
}

/**
 * Where a surface that is not a `done` starts, and where the cookie puts it again on the next page.
 *
 * Only a `done` opens on a screen, and only to report a wait: nothing covers the Assistant over an ask, which is
 * what the banner is for. An `unknown` sent away is gone rather than back on its banner, because it has said the one
 * thing it had to say; a `connect` sent away is back on its banner, because what it asked for is still missing.
 */
function initialView(ask: ConnectionsAsk, dismissed: boolean): "screen" | "notice" | "gone" {
  if (ask === "done") {
    return dismissed ? "notice" : "screen";
  }
  return dismissed && ask === "unknown" ? "gone" : "notice";
}

/** The kinds the hub has read a stored credential for, which is all the banner's wording needs of them. */
function storedKinds(statuses: CredentialStatus[]): Set<CredentialKind> {
  return new Set(statuses.filter((status) => status.stored).map((status) => status.kind));
}

/**
 * Which of the getting-ready surfaces the Assistant's pages show, if any.
 *
 * Someone with a connection still to make gets the banner, and the connections screen when they open it from there.
 * Someone who has onboarded waits instead when they arrive to an assistant that is not running: on the connections
 * screen while its pod is asking them to sign in, so they can act on it, and on the warming-up screen otherwise.
 * Every screen can be sent away, by its button or by Escape. What each leaves behind is what it still has to say: the
 * waiting ones a notice reporting the rest of the wait, the connections the banner that sent them, and the one about
 * sign-ins that cannot be checked nothing at all. Once the assistant is running no screen comes back this visit, and
 * nor is one shown to someone who arrived to one already running.
 *
 * No screen's state can live here alone, because each of the Assistant's pages mounts this afresh: the choice to send
 * one away is in the cookie `dismissed` is the page's reading of, and that the assistant has been running is in the
 * visit the layout holds. Hiding the waiting notice is the one thing not carried: it is small, and a navigation
 * bringing it back is what tells someone who hid it that their assistant has come up.
 *
 * Nobody is taken through the connections while the hub cannot read their credentials. `assistant.onboarded` is
 * false then whatever the person has stored, so asking on it would tell someone who has connected everything to
 * connect it again, and a screen on it would be satisfied only by the credentials the hub is failing to read. They
 * are told why once instead, on a banner they can send away, and that is remembered in the same cookie a wait's is,
 * so moving between pages does not bring it back.
 *
 * A sign-in the pod is holding for the person is the one ask none of those latches may hide. It is read live from the
 * sign-ins rather than from how far the assistant has got, for two reasons: a relay arriving after the page loaded
 * finds `waiting` and `ranOnce` already settled for the visit, and the assistant does not stay in `awaiting_login`
 * anyway — the last code dying takes it back to `running`, so a surface keyed to the status has nothing to show by
 * the time the codes have run out. It is a banner, like every other ask here, and the screen behind it opens only
 * when the person presses it: a code waiting is not worth taking away the conversation they are in the middle of.
 */
export function OnboardingGate({ dismissed = false, ...props }: Omit<Parameters<typeof GettingReady>[0], "onDone" | "returning"> & { dismissed?: boolean }) {
  const { assistant } = props;
  const visit = useVisit();
  // Read once rather than on a timer. All it decides is whether a relayed code is still live, and the ask has to
  // outlast the code either way: a banner that went quiet as the code ran out would take away the only thing saying
  // a sign-in is waiting, at the moment it most needs saying. It is also every Assistant page, so a clock here is a
  // re-render every few seconds for a deadline nobody is watching.
  const [now] = useState(() => Date.now());
  const ask = connectionsAsk(assistant.onboarded, props.unavailable);
  const [needed] = useState(ask === "connect");
  const [waiting] = useState(ask === "done" && assistant.status !== "running");
  const [done, setDone] = useState(false);
  const [asking, setAsking] = useState(false);
  const [view, setView] = useState<"screen" | "notice" | "gone">(() => initialView(ask, dismissed));
  const running = assistant.status === "running";
  // Latched while rendering rather than in an effect, which runs after paint: the frame the person would see at the
  // moment their assistant came up would be this screen saying it was ready, bar full, and then gone. Latched in the
  // visit as well, so an assistant that stops again — the idle sweep while they read — does not put the screen over
  // the page they are on, however many times they have moved between pages since it was up.
  const [ranOnce, setRanOnce] = useState(running || visit.ran);
  if (running && !ranOnce) {
    setRanOnce(true);
  }
  const started = running || ranOnce;
  useEffect(() => {
    if (running) {
      visit.sawRunning();
    }
  }, [running, visit]);
  const dismiss = useCallback(() => {
    setView("notice");
    rememberDismissal(assistant, true);
  }, [assistant]);
  const show = () => {
    setView("screen");
    rememberDismissal(assistant, false);
  };
  // An `unknown` sent away has nothing left to say, so it goes rather than leaving its banner behind.
  const hide = useCallback(() => {
    setView("gone");
    rememberDismissal(assistant, true);
  }, [assistant]);
  const stopAsking = useCallback(() => setAsking(false), []);
  // Every sign-in the hub can see, so what the banner says is the same answer the cog badges on. Empty while the
  // credentials cannot be read, which is the one case nothing here is allowed to make a claim about.
  const rows = connections(
    { kinds: [...assistant.needed, ...assistant.optional], statuses: props.statuses, logins: assistant.logins, unavailable: props.unavailable },
    (stored, login) => checklistState(stored, login, now)
  );
  const relayed = signInPrompt(rows);
  const onboarding = (ask === "connect" || (needed && !done)) && view === "screen";
  const unknown = ask === "unknown" && view === "screen";
  const screen = waiting && !started && !onboarding && !unknown && view === "screen";
  const signIn = relayed !== null && asking && !onboarding && !unknown && !screen;
  useEscape(onboarding || unknown || screen || signIn, unknown ? hide : signIn ? stopAsking : dismiss);
  if (onboarding) {
    return <GettingReady {...props} onDone={() => setDone(true)} onLeave={dismiss} />;
  }
  if (unknown) {
    return <GettingReady {...props} onDone={hide} />;
  }
  if (screen) {
    return waitingForPerson(assistant.status) ? (
      <GettingReady {...props} returning onDone={dismiss} />
    ) : (
      <WarmingUp assistant={assistant} unavailable={props.unavailable} theme={props.theme} onDismiss={dismiss} />
    );
  }
  if (signIn) {
    return <GettingReady {...props} returning onDone={stopAsking} />;
  }
  // Sent away for good, which only an `unknown` is ever allowed to be: an ask with something still to connect
  // outlasts anything the person closes, because it is the only thing telling them why nothing works.
  const silenced = view === "gone" && ask === "unknown";
  const prompt = silenced ? null : connectionsPrompt(ask, assistant.needed, storedKinds(props.statuses));
  if (prompt !== null) {
    return <ConnectionsBanner prompt={prompt} onShow={show} onHide={ask === "unknown" ? hide : undefined} />;
  }
  // Not hideable, for the same reason the ask to connect is not: it is the only thing telling the person their
  // assistant is holding a code for them, and it clears itself the moment they have used it.
  if (relayed !== null) {
    return <ConnectionsBanner prompt={relayed} onShow={() => setAsking(true)} />;
  }
  // Only for a wait this visit began on: someone who arrives to an assistant already up is not shown the end of a
  // wait they never saw, however recently they sent one away.
  return waiting && view === "notice" ? <WaitingNotice assistant={assistant} onShow={show} onHide={() => setView("gone")} /> : null;
}
