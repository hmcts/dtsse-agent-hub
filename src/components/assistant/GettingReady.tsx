"use client";

import { useEffect, useState } from "react";
import type { Theme } from "@/assistant/theme";
import type { AssistantSummary } from "@/assistant/views";
import {
  firstWarmupMessage,
  nextWarmupMessage,
  WARMUP_PATIENCE_MS,
  WARMUP_ROTATE_MS,
  WARMUP_SIGNPOST,
  WARMUP_SLOW,
  type WarmupPhase,
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
 */
function useWarmupMessage(phase: WarmupPhase, rotating: boolean): { message: string; slow: boolean } {
  const [message, setMessage] = useState(() => firstWarmupMessage(phase));
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!rotating) {
      return;
    }
    const timer = setTimeout(() => setSlow(true), WARMUP_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [rotating]);
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
 * The first visit: the assistant warms up while the person connects the accounts it works with. The sign-ins come
 * from the assistant's pod as it reaches each one, so a connection shows "Connecting…" until its code appears. Once
 * every needed account is connected the person carries on; they are not shown this again.
 */
export function GettingReady({
  assistant,
  statuses,
  unavailable,
  paste,
  save,
  onDone,
  theme = "system"
}: ScreenProps & {
  statuses: CredentialStatus[];
  paste: FormAction;
  save: FormAction;
  onDone: () => void;
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
      subtitle="While it gets ready, connect the tools it needs to work with your repos, tickets and pipelines."
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
        <button
          type="button"
          onClick={onDone}
          disabled={!canContinue}
          className="h-[42px] rounded-[10px] bg-asst-accent px-5 text-sm font-semibold text-asst-ink disabled:opacity-40"
        >
          {canContinue ? "Start chatting" : "Connect the accounts above to continue"}
        </button>
      </div>
    </ReadyShell>
  );
}

/**
 * A return visit to an assistant that is not running: the same progress, with nothing to do but wait, so a rotating
 * line keeps the person company and says how long this takes. The connections are all made, so they are not listed.
 */
export function WarmingUp({ assistant, unavailable, theme = "system" }: ScreenProps) {
  const { failed } = assistant.readiness;
  const { message, slow } = useWarmupMessage(warmupPhase(assistant.status), !failed);
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
    </ReadyShell>
  );
}

/**
 * Shows the getting-ready screen until the person has connected everything, and then until they choose to carry on.
 * Someone who has onboarded already waits on the warming-up screen instead when they arrive to a stopped assistant,
 * until it is running; once it is, they are not shown it again this visit, and nor is anyone who arrived to one
 * already running.
 */
export function OnboardingGate(props: Omit<Parameters<typeof GettingReady>[0], "onDone">) {
  const [needed] = useState(!props.assistant.onboarded);
  const [waiting] = useState(props.assistant.onboarded && props.assistant.status !== "running");
  const [done, setDone] = useState(false);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (props.assistant.status === "running") {
      setStarted(true);
    }
  }, [props.assistant.status]);
  if (props.assistant.onboarded && (!needed || done)) {
    return waiting && !started ? <WarmingUp assistant={props.assistant} unavailable={props.unavailable} theme={props.theme} /> : null;
  }
  return <GettingReady {...props} onDone={() => setDone(true)} />;
}
