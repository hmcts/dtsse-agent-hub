"use client";

import { useCallback, useEffect, useState } from "react";
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
import { ThemeSwitch } from "@/components/assistant/ThemeSwitch";
import { LoginCountdown } from "@/components/virtual-agents/LoginCountdown";
import { checklistState } from "@/components/virtual-agents/OnboardingChecklist";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { LoginView } from "@/virtual-agents/logins";

/** Each connection in words for someone who has never configured one. */
const CONNECTORS: Partial<Record<CredentialKind, { name: string; initial: string; desc: string }>> = {
  github: { name: "GitHub", initial: "G", desc: "Read repositories and open pull requests" },
  azure: { name: "Azure", initial: "Az", desc: "Your HMCTS account, for pipelines and environments" },
  atlassian: { name: "Atlassian", initial: "A", desc: "Jira tickets and Confluence pages (optional)" },
  claude: { name: "Claude", initial: "C", desc: "Your Claude licence" },
  bedrock: { name: "AI model access", initial: "AI", desc: "Your Amazon Bedrock API key" }
};

/** An Atlassian sign-in is the one optional connection worth offering here; a Jenkins token is for engineers. */
const OFFERED_OPTIONAL: readonly CredentialKind[] = ["atlassian"];

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
  const [message, setMessage] = useState(() => firstWarmupMessage(phase));
  const now = useNow();
  const slow = rotating && now - since >= WARMUP_PATIENCE_MS;
  useEffect(() => {
    if (!rotating || slow) {
      return;
    }
    const timer = setInterval(() => setMessage((previous) => nextWarmupMessage(phase, previous, Math.random())), WARMUP_ROTATE_MS);
    return () => clearInterval(timer);
  }, [phase, rotating, slow]);
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

function Connector({
  kind,
  stored,
  login,
  assistantId,
  starting,
  paste,
  save,
  now,
  first
}: {
  kind: CredentialKind;
  stored: boolean;
  login: LoginView | undefined;
  assistantId: string;
  starting: boolean;
  paste: FormAction;
  save: FormAction;
  now: number;
  first: boolean;
}) {
  const [connecting, setConnecting] = useState(false);
  const connector = CONNECTORS[kind] ?? { name: kind, initial: kind.slice(0, 1).toUpperCase(), desc: "" };
  const state = checklistState(stored, login, now);
  // A Bedrock key is the one connection with no sign-in: the person pastes it.
  const pasted = kind === "bedrock";
  let right: React.ReactNode;
  if (state === "stored") {
    right = <span className="shrink-0 text-[13px] font-medium text-asst-ok">✓ Connected</span>;
  } else if (state === "login" || (!pasted && (connecting || starting))) {
    right = <span className="shrink-0 text-[13px] text-asst-accent-soft">{state === "login" ? "Waiting for you" : "Connecting…"}</span>;
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
      {state === "login" && login !== undefined ? <SignIn assistantId={assistantId} login={login} name={connector.name} paste={paste} /> : null}
      {state !== "stored" && pasted && connecting ? (
        <ActionForm action={save} label="Save your Bedrock API key" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="kind" value="bedrock" />
          <input name="value" type="password" required autoComplete="off" spellCheck={false} aria-label="Bedrock API key" className={INPUT} />
          <button type="submit" className={PRIMARY}>
            Save
          </button>
        </ActionForm>
      ) : null}
      {state !== "stored" && !pasted && connecting && state !== "login" ? (
        <p className="text-xs text-asst-faint">Your assistant asks for this as it starts. The sign-in will appear here.</p>
      ) : null}
      {state !== "login" && login?.state === "failed" ? (
        <p role="alert" className="text-xs text-asst-error">
          That sign-in did not work. Your assistant will ask again.
        </p>
      ) : null}
    </li>
  );
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
 * "Connecting…" until its code appears. On a first visit it is the whole of getting ready: the assistant warms up
 * while the person connects the accounts it works with, and once every needed one is connected they carry on.
 * `returning` is the other way in — someone who connected everything on an earlier visit, whose assistant has
 * stopped to ask them to sign in again — so the screen asks for that rather than introducing the connections, and
 * its button leaves rather than finishing anything.
 */
export function GettingReady({
  assistant,
  statuses,
  unavailable,
  paste,
  save,
  onDone,
  returning = false,
  theme = "system"
}: ScreenProps & {
  statuses: CredentialStatus[];
  paste: FormAction;
  save: FormAction;
  onDone: () => void;
  returning?: boolean;
}) {
  const now = useNow();
  const stored = (kind: CredentialKind) => statuses.some((status) => status.kind === kind && status.stored);
  const kinds = [...assistant.needed, ...assistant.optional.filter((kind) => OFFERED_OPTIONAL.includes(kind))];
  const starting = !assistant.readiness.failed && assistant.status !== "running";
  const canContinue = assistant.onboarded;
  return (
    <ReadyShell
      assistant={assistant}
      unavailable={unavailable}
      theme={theme}
      subtitle={
        returning
          ? "Your assistant is waiting for you to sign in again before it can carry on."
          : "While it gets ready, connect the tools it needs to work with your repos, tickets and pipelines."
      }
    >
      <ul aria-label="Connections" className="flex flex-col overflow-hidden rounded-[14px] border border-asst-line">
        {kinds.map((kind, index) => (
          <Connector
            key={kind}
            kind={kind}
            stored={stored(kind)}
            login={assistant.logins.find((login) => login.kind === kind)}
            assistantId={assistant.id}
            starting={starting}
            paste={paste}
            save={save}
            now={now}
            first={index === 0}
          />
        ))}
      </ul>
      <div className="flex justify-end">
        <button type="button" onClick={onDone} disabled={!canContinue} className={FOOTER_PRIMARY}>
          {canContinue ? (returning ? "Carry on without waiting" : "Start chatting") : "Connect the accounts above to continue"}
        </button>
      </div>
    </ReadyShell>
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

/** Closes the waiting screen on Escape, which `aria-modal` leads a keyboard user to expect, while it is the one up. */
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
function rememberDismissal(assistantId: string, dismissed: boolean): void {
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing from browsers HMCTS staff still use
  document.cookie = waitingCookie(dismissed ? assistantId : null);
}

/**
 * Shows the getting-ready screen until the person has connected everything, and then until they choose to carry on.
 * Someone who has onboarded already waits instead when they arrive to an assistant that is not running: on the
 * connections screen while its pod is asking them to sign in, so they can act on it, and on the warming-up screen
 * otherwise. Either can be sent away, by its button or by Escape, leaving a notice that reports the rest of the
 * wait. Once the assistant is running neither comes back this visit, and nor is either shown to someone who arrived
 * to one already running.
 *
 * `dismissed` is the page's reading of the cookie that carries the choice between the Assistant's pages, since each
 * of them mounts this afresh. Hiding the notice is not carried: it is small, and a navigation bringing it back is
 * what tells someone who hid it that their assistant has come up.
 */
export function OnboardingGate({ dismissed = false, ...props }: Omit<Parameters<typeof GettingReady>[0], "onDone" | "returning"> & { dismissed?: boolean }) {
  const [needed] = useState(!props.assistant.onboarded);
  const [waiting] = useState(props.assistant.onboarded && props.assistant.status !== "running");
  const [done, setDone] = useState(false);
  const [view, setView] = useState<"screen" | "notice" | "gone">(dismissed ? "notice" : "screen");
  const running = props.assistant.status === "running";
  // Latched while rendering rather than in an effect, which runs after paint: the frame the person would see at the
  // moment their assistant came up would be this screen saying it was ready, bar full, and then gone. An assistant
  // that stops again later in the visit does not bring the screen back.
  const [ranOnce, setRanOnce] = useState(running);
  if (running && !ranOnce) {
    setRanOnce(true);
  }
  const started = running || ranOnce;
  const assistantId = props.assistant.id;
  const dismiss = useCallback(() => {
    setView("notice");
    rememberDismissal(assistantId, true);
  }, [assistantId]);
  const show = () => {
    setView("screen");
    rememberDismissal(assistantId, false);
  };
  const onboarding = !props.assistant.onboarded || (needed && !done);
  const screen = waiting && !started && !onboarding && view === "screen";
  useEscape(screen, dismiss);
  if (onboarding) {
    return <GettingReady {...props} onDone={() => setDone(true)} />;
  }
  if (screen) {
    return waitingForPerson(props.assistant.status) ? (
      <GettingReady {...props} returning onDone={dismiss} />
    ) : (
      <WarmingUp assistant={props.assistant} unavailable={props.unavailable} theme={props.theme} onDismiss={dismiss} />
    );
  }
  return view === "notice" ? <WaitingNotice assistant={props.assistant} onShow={show} onHide={() => setView("gone")} /> : null;
}
