"use client";

import { useState } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { JenkinsHint } from "@/components/credentials/JenkinsHint";
import { Section } from "@/components/Section";
import { PencilIcon, ReconnectIcon } from "@/components/sidebar/icons";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { VirtualAgentDesired } from "@/virtual-agents/lifecycle";
import type { LoginView } from "@/virtual-agents/logins";
import { LoginCountdown } from "./LoginCountdown";

const TITLES: Record<CredentialKind, string> = {
  github: "GitHub",
  azure: "Azure",
  claude: "Claude",
  bedrock: "Bedrock API key",
  jenkins: "Jenkins API token"
};

/** The kinds the owner can paste here; GitHub and Azure come only from the virtual agent's own sign-in. */
function isPasted(kind: CredentialKind): boolean {
  return kind === "bedrock" || kind === "jenkins" || kind === "claude";
}

/** What the owner pastes for `kind`: a Claude token, as opposed to the Claude sign-in. */
function pastedName(kind: CredentialKind): string {
  return kind === "claude" ? "Claude token" : TITLES[kind];
}

const INPUT = "mt-1 block w-full min-w-0 rounded-md border border-hub-line bg-hub-pane px-2 py-1 font-mono text-sm text-hub-text";
const FIELD = "block min-w-0 flex-1 basis-48";
const FORM = "flex min-w-0 flex-wrap items-end gap-3";
const BUTTON = "shrink-0 rounded bg-[#007a5a] px-3 py-1 text-sm font-medium text-white hover:bg-[#148567]";
const SECONDARY = "shrink-0 rounded border border-hub-line px-3 py-1 text-sm text-hub-text hover:bg-hub-raised";
const DANGER = "shrink-0 rounded bg-red-700 px-3 py-1 text-sm font-medium text-white hover:bg-red-600";
const ICON_BUTTON = "ml-auto shrink-0 rounded p-1 text-hub-muted hover:bg-hub-raised hover:text-white";

export type ChecklistState = "stored" | "login" | "waiting";

/** Where one credential stands: a login the owner has to act on comes first, then whether it is stored. */
export function checklistState(stored: boolean, login: LoginView | undefined, now: number): ChecklistState {
  if (login !== undefined && login.state === "pending" && new Date(login.expiresAt).getTime() > now) {
    return "login";
  }
  return stored ? "stored" : "waiting";
}

function PendingLogin({ virtualAgentId, login, paste }: { virtualAgentId: string; login: LoginView; paste: FormAction }) {
  const title = TITLES[login.kind];
  if (login.prompt === "device_code") {
    return (
      <div className="space-y-2">
        <p className="text-hub-text">
          Open{" "}
          <a href={login.verificationUri} target="_blank" rel="noreferrer noopener" className="break-all text-hub-link underline">
            {login.verificationUri}
          </a>{" "}
          and enter this code <LoginCountdown expiresAt={login.expiresAt} />:
        </p>
        <p>
          <span className="sr-only">{title} device code: </span>
          <code className="inline-block max-w-full break-all rounded-md border border-hub-line bg-hub-raised px-3 py-1 font-mono text-lg tracking-widest text-white">
            {login.userCode}
          </code>
        </p>
        <p className="text-xs text-hub-muted">Sign in as yourself. Your virtual agent carries on once you have.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-hub-text">
        Open{" "}
        <a href={login.verificationUri} target="_blank" rel="noreferrer noopener" className="text-hub-link underline">
          the {title} sign-in page
        </a>
        , sign in, and paste the code it gives you here <LoginCountdown expiresAt={login.expiresAt} />.
      </p>
      {login.codeWaiting ? (
        <p role="status" className="text-xs text-green-300">
          Your code is waiting for your virtual agent to collect it.
        </p>
      ) : (
        <ActionForm action={paste} label={`Paste the ${title} code`} className={FORM}>
          <input type="hidden" name="id" value={virtualAgentId} />
          <input type="hidden" name="kind" value={login.kind} />
          <label className={FIELD}>
            <span className="block text-hub-text">{title} code</span>
            <input name="code" type="password" required autoComplete="off" spellCheck={false} className={INPUT} />
          </label>
          <button type="submit" className={BUTTON}>
            Send
          </button>
        </ActionForm>
      )}
    </div>
  );
}

/** The owner's own key, saved straight into their credentials as on the credentials page; never shown back. */
function PasteCredential({ kind, stored, save, onCancel }: { kind: CredentialKind; stored: boolean; save: FormAction; onCancel?: () => void }) {
  const title = pastedName(kind);
  return (
    <ActionForm action={save} label={`Save your ${title}`} className={FORM}>
      <input type="hidden" name="kind" value={kind} />
      <label className={FIELD}>
        <span className="block text-hub-text">{stored ? `Replace your ${title}` : `Paste your ${title}`}</span>
        <input name="value" type="password" required autoComplete="off" spellCheck={false} className={INPUT} />
      </label>
      <button type="submit" className={BUTTON}>
        Save
      </button>
      {onCancel ? (
        <button type="button" className={SECONDARY} onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </ActionForm>
  );
}

function Header({ kind, detail, ticked, children }: { kind: CredentialKind; detail: string; ticked: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3">
      <h3 className="text-sm font-bold text-white">{TITLES[kind]}</h3>
      <span className={`text-xs ${ticked ? "text-green-300" : "text-hub-muted"}`}>{detail}</span>
      {children}
    </div>
  );
}

/** A stored key is not asked for again; the pencil opens the box to replace it. */
function PastedCard({ kind, stored, save }: { kind: CredentialKind; stored: boolean; save: FormAction }) {
  const [replacing, setReplacing] = useState(false);
  const title = pastedName(kind);
  return (
    <>
      <Header kind={kind} detail={stored ? "✓ Stored" : "Not stored"} ticked={stored}>
        {stored && !replacing ? (
          <button type="button" className={ICON_BUTTON} aria-label={`Replace your ${title}`} onClick={() => setReplacing(true)}>
            <PencilIcon />
          </button>
        ) : null}
      </Header>
      {kind === "jenkins" ? <JenkinsHint /> : null}
      {!stored ? <PasteCredential kind={kind} stored={false} save={save} /> : null}
      {stored && replacing ? <PasteCredential kind={kind} stored save={save} onCancel={() => setReplacing(false)} /> : null}
    </>
  );
}

/**
 * Signing in again deletes the owner's stored credential, which all their virtual agents use, so it asks first. A
 * running agent restarts to relay a fresh sign-in; a stopped one asks when it next starts.
 */
function Reconnect({ virtualAgentId, kind, running, reconnect }: { virtualAgentId: string; kind: CredentialKind; running: boolean; reconnect: FormAction }) {
  const [confirming, setConfirming] = useState(false);
  const title = TITLES[kind];
  if (!confirming) {
    return (
      <button type="button" className={ICON_BUTTON} aria-label={`Reconnect ${title}`} onClick={() => setConfirming(true)}>
        <ReconnectIcon />
      </button>
    );
  }
  return (
    <div className="basis-full space-y-2 pt-2" role="group" aria-label={`Confirm reconnecting ${title}`}>
      <p className="text-sm text-hub-text">
        {running
          ? `Delete your stored ${title} sign-in, which all your virtual agents use, and restart this one so it asks you to sign in again?`
          : `Delete your stored ${title} sign-in, which all your virtual agents use? This one is stopped, so it asks you to sign in when it next starts.`}
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <ActionForm action={reconnect} label={`Reconnect ${title}`}>
          <input type="hidden" name="id" value={virtualAgentId} />
          <input type="hidden" name="kind" value={kind} />
          <button type="submit" className={DANGER}>
            {running ? `Reconnect ${title}` : `Delete ${title} sign-in`}
          </button>
        </ActionForm>
        <button type="button" className={SECONDARY} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Card({
  virtualAgentId,
  kind,
  status,
  login,
  desired,
  paste,
  save,
  reconnect,
  now
}: {
  virtualAgentId: string;
  kind: CredentialKind;
  status: CredentialStatus | undefined;
  login: LoginView | undefined;
  desired: VirtualAgentDesired;
  paste: FormAction;
  save: FormAction;
  reconnect: FormAction;
  now: number;
}) {
  const stored = status?.stored === true;
  const state = checklistState(stored, login, now);
  let body: React.ReactNode;
  if (state === "login" && login !== undefined) {
    body = (
      <>
        <Header kind={kind} detail="Sign-in waiting for you" ticked={false} />
        <PendingLogin virtualAgentId={virtualAgentId} login={login} paste={paste} />
      </>
    );
  } else if (isPasted(kind)) {
    body = <PastedCard kind={kind} stored={stored} save={save} />;
  } else {
    body = (
      <Header kind={kind} detail={stored ? "✓ Connected" : "Waiting for your virtual agent to ask"} ticked={stored}>
        {stored && desired !== "deleted" ? (
          <Reconnect virtualAgentId={virtualAgentId} kind={kind} running={desired === "running"} reconnect={reconnect} />
        ) : null}
      </Header>
    );
  }
  return (
    <li className="min-w-0 space-y-2 border-b border-hub-line px-4 py-3 last:border-b-0">
      {body}
      {state !== "login" && login?.state === "failed" ? (
        <p role="alert" className="text-xs text-red-300">
          The last {TITLES[kind]} sign-in failed.
        </p>
      ) : null}
    </li>
  );
}

/**
 * What the virtual agent needs before it can work, one card per credential: stored, a sign-in waiting for the owner
 * with its code or a box to paste one into, or nothing yet. A key the owner pastes (Bedrock, Claude, the optional
 * Jenkins token) offers its box until it is stored; GitHub and Azure come from the agent's own sign-in, which the
 * owner can have it do again. Only the owner ever sees this page.
 */
export function OnboardingChecklist({
  virtualAgentId,
  desired,
  needed,
  optional = [],
  statuses,
  logins,
  paste,
  save,
  reconnect,
  now,
  unavailable
}: {
  virtualAgentId: string;
  desired: VirtualAgentDesired;
  needed: CredentialKind[];
  /** Shown after the needed ones: the agent starts without them. */
  optional?: CredentialKind[];
  statuses: CredentialStatus[];
  logins: LoginView[];
  paste: FormAction;
  save: FormAction;
  reconnect: FormAction;
  now: number;
  unavailable?: string;
}) {
  const shown = [...needed, ...optional];
  const storedCount = shown.filter((kind) => statuses.find((status) => status.kind === kind)?.stored).length;
  return (
    <Section heading="Sign-ins" detail={`${storedCount} of ${shown.length} stored`}>
      {unavailable ? <p className="pb-3 text-sm text-hub-muted">{unavailable}</p> : null}
      <ul aria-label="Sign-ins" className="-mx-4 -mb-4 min-w-0">
        {shown.map((kind) => (
          <Card
            key={kind}
            virtualAgentId={virtualAgentId}
            kind={kind}
            status={statuses.find((status) => status.kind === kind)}
            login={logins.find((login) => login.kind === kind)}
            desired={desired}
            paste={paste}
            save={save}
            reconnect={reconnect}
            now={now}
          />
        ))}
      </ul>
    </Section>
  );
}
