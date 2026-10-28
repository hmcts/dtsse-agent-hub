"use client";

import { useState } from "react";
import { type ConnectionState, codeCollectable, connectionState, hasLapsed, signsInOnRequest } from "@/assistant/connections";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { AtlassianHint } from "@/components/credentials/AtlassianHint";
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
  bedrock: "Amazon Bedrock API key",
  jenkins: "Jenkins API token",
  claude_md: "CLAUDE.md",
  git_identity: "Git identity",
  atlassian: "Atlassian (Jira & Confluence)"
};

/** The kinds the owner can paste here; GitHub, Azure and Atlassian come only from the virtual agent's own sign-in. */
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

/**
 * What a card says beside its name, by where `connectionState` says its credential stands. One table for every card,
 * so the words and the tick on them cannot say different things: a stored credential a pod has just failed to use is
 * not connected, and a card claiming it is leaves the owner nothing to act on.
 *
 * The Assistant's `CONNECTION_DETAILS` words the same states for a person reading their own sign-ins. These are this
 * page's words for an owner reading one agent's credentials, which is a different question: a tick for the cards that
 * carry one, and "waiting" meaning waiting for the agent to ask rather than "not connected".
 */
const SIGN_IN_DETAIL: Record<ConnectionState, string> = {
  connected: "✓ Connected",
  finishing: "Finishing signing in",
  refreshing: "Sign-in waiting for you",
  "signing-in": "Sign-in waiting for you",
  expired: "Sign-in expired",
  failed: "Last sign-in failed",
  waiting: "Waiting for your virtual agent to ask"
};

/**
 * The same states for a sign-in the agent makes only when the owner asks (`ON_REQUEST`): it never asks by itself, so
 * "waiting" is simply not connected, and the card's reconnect is how the owner asks.
 */
const ON_REQUEST_DETAIL: Record<ConnectionState, string> = { ...SIGN_IN_DETAIL, waiting: "Not connected (optional)" };

/** The same states for a key the owner pastes, where the question is whether a value is there rather than signed in. */
const PASTED_DETAIL: Record<ConnectionState, string> = { ...SIGN_IN_DETAIL, connected: "✓ Stored", waiting: "Not stored" };

/** Why a lapsed sign-in lapsed, which is what says whether the owner has a code to enter or a failure to read. */
function lapsedLine(kind: CredentialKind, state: ConnectionState): string {
  return state === "failed" ? `The last ${TITLES[kind]} sign-in failed.` : `The last ${TITLES[kind]} sign-in ran out before anyone used it.`;
}

/**
 * `collectable` is whether a code the owner pasted is still there for the pod, rather than whether they ever pasted
 * one: a code the pod never came for is no use after `PASTED_CODE_TTL_MS` while the sign-in itself can run for the
 * rest of the hour, and `storePastedCode` will take another — so the box comes back rather than the card promising
 * for the next fifty minutes that a dead code is on its way.
 */
function PendingLogin({ virtualAgentId, login, collectable, paste }: { virtualAgentId: string; login: LoginView; collectable: boolean; paste: FormAction }) {
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
      {collectable ? (
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

/**
 * A key whose value is there and nothing says otherwise is not asked for again; the pencil opens the box to replace
 * it. A stored key a later sign-in lapsed over is asked for, because the card beside it says it has stopped working
 * and a tick with nothing to press would be the card disagreeing with its own alert.
 */
function PastedCard({ kind, stored, state, save }: { kind: CredentialKind; stored: boolean; state: ConnectionState; save: FormAction }) {
  const [replacing, setReplacing] = useState(false);
  const title = pastedName(kind);
  const usable = state === "connected";
  return (
    <>
      <Header kind={kind} detail={PASTED_DETAIL[state]} ticked={usable}>
        {usable && !replacing ? (
          <button type="button" className={ICON_BUTTON} aria-label={`Replace your ${title}`} onClick={() => setReplacing(true)}>
            <PencilIcon />
          </button>
        ) : null}
      </Header>
      {kind === "jenkins" ? <JenkinsHint /> : null}
      {!usable ? <PasteCredential kind={kind} stored={stored} save={save} /> : null}
      {usable && replacing ? <PasteCredential kind={kind} stored save={save} onCancel={() => setReplacing(false)} /> : null}
    </>
  );
}

/** What the confirmation asks and what the button that answers it is called, by what the action will actually do. */
function reconnectWords(title: string, stored: boolean, running: boolean): { question: string; confirm: string } {
  if (!stored) {
    // Nothing to delete: the value went with the sign-in, or there never was one, or it is a first connect of a
    // sign-in the agent makes only on request. All this does is restart.
    return {
      question: running
        ? `Restart this virtual agent so it asks you to sign in to ${title} again?`
        : `Have this virtual agent sign in to ${title} again? It is stopped, so it asks you when it next starts.`,
      confirm: `Reconnect ${title}`
    };
  }
  return {
    question: running
      ? `Delete your stored ${title} sign-in, which all your virtual agents use, and restart this one so it asks you to sign in again?`
      : `Delete your stored ${title} sign-in, which all your virtual agents use? This one is stopped, so it asks you to sign in when it next starts.`,
    confirm: running ? `Reconnect ${title}` : `Delete ${title} sign-in`
  };
}

/**
 * Signing in again restarts the agent so its pod relays a fresh sign-in, and deletes the owner's stored credential on
 * the way if there is one — which all their virtual agents use, so it asks first and says so. A stopped agent asks
 * when it next starts. Offered for a lapsed sign-in with nothing stored too: nothing re-relays by itself, so without
 * it that card is a card saying the sign-in is dead with no way to ask for another.
 */
function Reconnect({
  virtualAgentId,
  kind,
  stored,
  running,
  reconnect
}: {
  virtualAgentId: string;
  kind: CredentialKind;
  stored: boolean;
  running: boolean;
  reconnect: FormAction;
}) {
  const [confirming, setConfirming] = useState(false);
  const title = TITLES[kind];
  const words = reconnectWords(title, stored, running);
  if (!confirming) {
    return (
      <button type="button" className={ICON_BUTTON} aria-label={`Reconnect ${title}`} onClick={() => setConfirming(true)}>
        <ReconnectIcon />
      </button>
    );
  }
  return (
    <div className="basis-full space-y-2 pt-2" role="group" aria-label={`Confirm reconnecting ${title}`}>
      <p className="text-sm text-hub-text">{words.question}</p>
      <div className="flex flex-wrap items-start gap-2">
        <ActionForm action={reconnect} label={`Reconnect ${title}`}>
          <input type="hidden" name="id" value={virtualAgentId} />
          <input type="hidden" name="kind" value={kind} />
          <button type="submit" className={stored ? DANGER : BUTTON}>
            {words.confirm}
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
  const connection = connectionState(state, login, status, now);
  let body: React.ReactNode;
  if (state === "login" && login !== undefined) {
    body = (
      <>
        <Header kind={kind} detail={SIGN_IN_DETAIL[connection]} ticked={false} />
        <PendingLogin virtualAgentId={virtualAgentId} login={login} collectable={codeCollectable(login, now)} paste={paste} />
      </>
    );
  } else if (isPasted(kind)) {
    body = <PastedCard kind={kind} stored={stored} state={connection} save={save} />;
  } else {
    const onRequest = signsInOnRequest(kind);
    body = (
      <>
        <Header kind={kind} detail={(onRequest ? ON_REQUEST_DETAIL : SIGN_IN_DETAIL)[connection]} ticked={connection === "connected"}>
          {(stored || hasLapsed(connection) || (onRequest && connection === "waiting")) && desired !== "deleted" ? (
            <Reconnect virtualAgentId={virtualAgentId} kind={kind} stored={stored} running={desired === "running"} reconnect={reconnect} />
          ) : null}
        </Header>
        {kind === "atlassian" ? <AtlassianHint /> : null}
      </>
    );
  }
  return (
    <li className="min-w-0 space-y-2 border-b border-hub-line px-4 py-3 last:border-b-0">
      {body}
      {state !== "login" && hasLapsed(connection) ? (
        <p role="alert" className="text-xs text-red-300">
          {lapsedLine(kind, connection)}
        </p>
      ) : null}
    </li>
  );
}

/**
 * What the virtual agent needs before it can work, one card per credential: stored, a sign-in waiting for the owner
 * with its code or a box to paste one into, lapsed, or nothing yet. A key the owner pastes (Bedrock, Claude, the
 * optional Jenkins token) offers its box until it is stored; GitHub, Azure and the optional Atlassian come from the
 * agent's own sign-in, which the owner can have it do again. Only the owner ever sees this page.
 *
 * A stored credential is shown as connected only while no later sign-in has lapsed over it, which is `connectionState`
 * asking `lapsedSinceStored`: a credential a pod has just failed to use is still stored, so storage alone would tick
 * the one card that most needs the owner to act.
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
