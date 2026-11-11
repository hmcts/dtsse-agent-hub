"use client";

import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { type ConnectionRow, connectionRows } from "@/assistant/connection-rows";
import type { Connection, ConnectionState, MicrosoftConnection, ModelAccess } from "@/assistant/connections";
import { awaitsGithub, checklistState, codeCollectable, GITHUB_FIRST, offersConnect } from "@/assistant/connections";
import type { SavedCredential } from "@/assistant/saved-credentials";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { SignIn } from "@/components/assistant/SignIn";
import { useFocusOnMount } from "@/components/assistant/useFocusOnMount";
import { CONNECT_OUTCOME_PARAMETER, CONNECT_OUTCOME_WORDS, isConnectOutcome, MICROSOFT_UNAVAILABLE } from "@/microsoft/microsoft";
import type { ModelRoute } from "@/viewer/identity";
import type { LoginView } from "@/virtual-agents/logins";

/**
 * What a row needs to connect a sign-in the assistant makes only on request: the assistant it restarts and the action
 * that does it, `reconnectSignIn`, which the getting-ready screen's Connect and "Sign in again" post to as well; and
 * `pasteLoginCode`, which sends back the code a relayed sign-in gives the person, as the getting-ready screen does.
 */
export interface AssistantConnect {
  assistantId: string;
  /** Whether it is meant to be running, which is whether connecting restarts it now or asks when it next starts. */
  running: boolean;
  reconnect: FormAction;
  paste: FormAction;
}

/**
 * The person's saved credentials: what `saveCredential` accepts pasted, and what `removeCredential` removes. Which
 * kinds are which, and what removing each ends, is `savedCredentials`'s. A stored value is never shown.
 */
export interface AssistantTokens {
  rows: SavedCredential[];
  /** Why the hub cannot read the person's credentials, which is not the same as their having none. */
  unavailable: string | null;
  save: FormAction;
  remove: FormAction;
}

/** What the Connections section reads of the dialog's view. */
export interface ConnectionsView {
  list: Connection[];
  /** The sign-ins the assistant's pod has relayed, which a row shows while one is live. */
  logins: readonly LoginView[];
  /** The clock `list` was read against, so a row and its sign-in agree on whether the code is still live. */
  now: number;
  /** How this person's agents reach Claude, where that is not one of `list`'s own rows. */
  access: ModelAccess | null;
  connect: AssistantConnect | undefined;
  /** The person's Microsoft 365 connection, or `null` where the hub cannot read their credentials. */
  microsoft: MicrosoftConnection | null;
  route: ModelRoute;
  unavailable: string | null;
  warning: string | null;
  tokens: AssistantTokens | undefined;
}

const STATE_CLASS: Record<ConnectionState, string> = {
  connected: "text-asst-ok",
  // The person has sent the code back and the pod has yet to collect it, so there is nothing for them to do.
  finishing: "text-asst-muted",
  // A relayed sign-in is a wait on the person whether or not a credential sits behind it: a pod relays a code
  // because it cannot finish without them, so it is coloured as something to do rather than as a quiet renewal.
  refreshing: "text-asst-accent-soft",
  "signing-in": "text-asst-accent-soft",
  expired: "text-asst-warn",
  failed: "text-asst-error",
  waiting: "text-asst-muted"
};

const ACCENT_BUTTON =
  "shrink-0 rounded-[9px] border border-asst-accent-line px-3 py-1 text-xs font-medium text-asst-accent-soft hover:bg-asst-accent hover:text-asst-ink";
const QUIET_BUTTON = "shrink-0 rounded-[9px] border border-asst-line px-3 py-1 text-xs font-medium text-asst-muted hover:text-asst-text";
const CANCEL = "shrink-0 text-[13px] font-medium text-asst-muted hover:text-asst-text";
const FIELD =
  "block w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 font-plex-mono text-[13px] text-asst-text outline-hidden focus:border-asst-accent-line";
/** Where a row's question or field opens: under the row, the full width of it. */
const BELOW = "flex basis-full flex-col gap-2 pt-1";

/** What connecting asks first and what its button says, by whether a saved sign-in goes and whether it restarts. */
function connectWords(name: string, stored: boolean, running: boolean): { question: string; confirm: string } {
  if (stored) {
    return {
      question: running
        ? `Delete your saved ${name} sign-in, which all your virtual agents use, and restart your assistant so it asks you to sign in again? Your chats are kept.`
        : `Delete your saved ${name} sign-in, which all your virtual agents use? Your assistant is stopped, so it asks you to sign in when it next starts.`,
      confirm: `Sign in to ${name}`
    };
  }
  return {
    question: running
      ? `Restart your assistant so it asks you to sign in to ${name}? Your chats are kept.`
      : `Have your assistant ask you to sign in to ${name}? It is stopped, so it asks when it next starts.`,
    confirm: `Connect ${name}`
  };
}

/**
 * Connecting a sign-in made on request. Its pod relays one only as it starts, and off the `gateway` route only once
 * asked, so connecting is `reconnectSignIn`: record the ask and restart. Behind a confirmation because the restart ends
 * whatever the assistant is doing, and because a lapsed sign-in with a value saved deletes the one all their agents
 * use. The code then arrives on this row, as it does on the getting-ready screen.
 */
function ConnectQuestion({
  row,
  connect,
  onCancel,
  onDone
}: {
  row: Connection;
  connect: AssistantConnect;
  onCancel: () => void;
  /** Closes the question once the restart is asked for, so it is not back on the row when the sign-in it led to is over. */
  onDone: (said: string | null) => void;
}) {
  const confirm = useFocusOnMount<HTMLButtonElement>();
  const words = connectWords(row.name, row.stored, connect.running);
  return (
    <ActionForm action={connect.reconnect} label={`Connect ${row.name}`} className={BELOW} onSuccess={(result) => onDone(result.confirmation ?? null)}>
      <input type="hidden" name="id" value={connect.assistantId} />
      <input type="hidden" name="kind" value={row.kind} />
      <p className="text-pretty text-[13px] font-semibold text-asst-text">{words.question}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          ref={confirm}
          type="submit"
          className={`shrink-0 rounded-[10px] px-3.5 py-2 text-[13px] font-semibold ${row.stored ? "bg-asst-error text-asst-ink" : "bg-asst-accent text-asst-ink hover:bg-asst-accent-hover"}`}
        >
          {words.confirm}
        </button>
        <button type="button" onClick={onCancel} className={CANCEL}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

function Paste({ saved, save, onCancel, onSaved }: { saved: SavedCredential; save: FormAction; onCancel: () => void; onSaved: () => void }) {
  const id = useId();
  const field = useFocusOnMount<HTMLInputElement>();
  return (
    <ActionForm action={save} label={`Save your ${saved.title}`} onSuccess={onSaved} className={BELOW}>
      <input type="hidden" name="kind" value={saved.kind} />
      <label htmlFor={`${id}-value`} className="text-[13px] font-medium">
        {saved.stored ? `New ${saved.title}` : saved.title}
      </label>
      <input ref={field} id={`${id}-value`} name="value" type="password" required autoComplete="off" spellCheck={false} className={FIELD} />
      <div className="flex items-center gap-3">
        {/* Named for what it saves, so it is never read as the dialog's own Save, which saves the settings. */}
        <button type="submit" className="rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover">
          Save token
        </button>
        <button type="button" onClick={onCancel} className={CANCEL}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

function Remove({
  kind,
  label,
  question,
  confirm: confirmWord,
  remove,
  onCancel,
  onRemoved
}: {
  kind: string;
  label: string;
  question: string;
  confirm: string;
  remove: FormAction;
  onCancel: () => void;
  onRemoved: () => void;
}) {
  const confirm = useFocusOnMount<HTMLButtonElement>();
  return (
    <ActionForm action={remove} label={label} onSuccess={onRemoved} className={BELOW}>
      <input type="hidden" name="kind" value={kind} />
      <p className="text-pretty text-[13px] font-semibold text-asst-text">{question}</p>
      <div className="flex flex-wrap items-center gap-3">
        <button ref={confirm} type="submit" className="shrink-0 rounded-[10px] bg-asst-error px-3.5 py-2 text-[13px] font-semibold text-asst-ink">
          {confirmWord}
        </button>
        <button type="button" onClick={onCancel} className={CANCEL}>
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

/**
 * Microsoft 365's Connect, which the person makes in a browser sign-in of the hub's rather than through their
 * assistant: a form rather than a link, so only this page can start one, and no restart.
 */
function MicrosoftConnect({ microsoft }: { microsoft: MicrosoftConnection }) {
  return (
    <form method="post" action={microsoft.connectPath} className="flex shrink-0 items-center">
      <input type="hidden" name="redirect" value={microsoft.returnTo} />
      <button type="submit" aria-label="Connect Microsoft 365" className={ACCENT_BUTTON}>
        Connect
      </button>
    </form>
  );
}

type Doing = "connect" | "paste" | "remove" | null;

/**
 * One service: where it stands, and every action it has. Connect (or "Sign in again") is the sign-in's, made by the
 * assistant; Add or Replace pastes a token where `saveCredential` takes one; Remove deletes what is saved. Microsoft 365
 * connects in the hub's own sign-in and disconnects through `removeCredential`, with no restart, since agents ask the
 * hub for a token each time and are refused from then on. One question or field is open on a row at a time.
 */
function Row({
  row,
  connect,
  tokens,
  login,
  now,
  held,
  onSaid
}: {
  row: ConnectionRow;
  connect: AssistantConnect | undefined;
  tokens: AssistantTokens | undefined;
  /** The sign-in the pod relayed for this row's kind, if any. */
  login: LoginView | undefined;
  now: number;
  /** Whether Connect and Add wait for GitHub: `awaitsGithub`. Remove does not, since it only takes something away. */
  held: boolean;
  onSaid: (said: string | null) => void;
}) {
  const [doing, setDoing] = useState<Doing>(null);
  const outcome = useSearchParams().get(CONNECT_OUTCOME_PARAMETER);
  const { signIn, saved, microsoft } = row;
  const start = (what: Doing) => () => {
    onSaid(null);
    setDoing(what);
  };
  const finish = (said: string) => () => {
    setDoing(null);
    onSaid(said);
  };
  // A code the pod relayed is the one thing to do on the row while it is live: shown here as on the getting-ready
  // screen, with nothing beside it that would restart the assistant or replace the credential out from under it.
  const live = signIn !== null && login !== undefined && checklistState(signIn.stored, login, now) === "login";
  const connectable = !live && connect !== undefined && signIn !== null && offersConnect(signIn);
  const pasteable = !live && tokens !== undefined && saved?.pasteable === true;
  const removable = !live && tokens !== undefined && saved?.stored === true;
  const disconnectable = tokens !== undefined && microsoft?.stored === true;
  const microsoftConnect = microsoft !== null && !microsoft.stored && microsoft.connectable;
  const heldBack = held && (connectable || pasteable || microsoftConnect);
  const offered = {
    connect: connectable && !held,
    paste: pasteable && !held,
    microsoft: microsoftConnect && !held
  };
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-asst-line px-3.5 py-3 last:border-b-0">
      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-asst-active text-xs font-semibold">
        {row.initial}
      </span>
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium">{row.name}</span>
        <span className="truncate text-xs text-asst-muted">{row.desc}</span>
      </div>
      <span className={`shrink-0 text-xs font-medium ${STATE_CLASS[row.state]}`}>{row.detail}</span>
      {doing === null && heldBack ? <span className="shrink-0 text-xs text-asst-muted">{GITHUB_FIRST}</span> : null}
      {doing === null && (offered.connect || offered.paste || removable || disconnectable || offered.microsoft) ? (
        <div className="flex shrink-0 items-center gap-2">
          {offered.connect && signIn !== null ? (
            <button type="button" onClick={start("connect")} aria-label={`Connect ${row.name}`} className={ACCENT_BUTTON}>
              {signIn.state === "waiting" ? "Connect" : "Sign in again"}
            </button>
          ) : null}
          {offered.paste && saved !== null ? (
            <button type="button" onClick={start("paste")} aria-label={`${saved.stored ? "Replace" : "Add"} your ${saved.title}`} className={QUIET_BUTTON}>
              {saved.stored ? "Replace" : "Add"}
            </button>
          ) : null}
          {removable && saved !== null ? (
            <button type="button" onClick={start("remove")} aria-label={`Remove your ${saved.title}`} className={QUIET_BUTTON}>
              Remove
            </button>
          ) : null}
          {disconnectable ? (
            <button type="button" onClick={start("remove")} className={QUIET_BUTTON}>
              Disconnect
            </button>
          ) : null}
          {offered.microsoft && microsoft !== null ? <MicrosoftConnect microsoft={microsoft} /> : null}
        </div>
      ) : null}
      {live && connect !== undefined && login !== undefined && signIn !== null ? (
        <div className={BELOW}>
          <SignIn assistantId={connect.assistantId} login={login} name={signIn.name} collectable={codeCollectable(login, now)} paste={connect.paste} />
        </div>
      ) : null}
      {doing === "connect" && !live && connect !== undefined && signIn !== null ? (
        <ConnectQuestion
          row={signIn}
          connect={connect}
          onCancel={() => setDoing(null)}
          onDone={(said) => {
            setDoing(null);
            onSaid(said);
          }}
        />
      ) : null}
      {doing === "paste" && !live && tokens !== undefined && saved !== null ? (
        <Paste saved={saved} save={tokens.save} onCancel={() => setDoing(null)} onSaved={finish(`Your ${saved.title} is saved`)} />
      ) : null}
      {doing === "remove" && !live && tokens !== undefined && saved !== null ? (
        <Remove
          kind={saved.kind}
          label={`Remove your ${saved.title}`}
          question={saved.removeQuestion}
          confirm="Remove"
          remove={tokens.remove}
          onCancel={() => setDoing(null)}
          onRemoved={finish(`Your ${saved.title} is removed`)}
        />
      ) : null}
      {doing === "remove" && tokens !== undefined && microsoft !== null ? (
        <Remove
          kind="microsoft"
          label="Disconnect Microsoft 365"
          question="Disconnect Microsoft 365? Your agents can no longer read your mail, calendar, Teams chats, meetings or files until you connect again."
          confirm="Disconnect"
          remove={tokens.remove}
          onCancel={() => setDoing(null)}
          onRemoved={finish("Microsoft 365 is disconnected")}
        />
      ) : null}
      {/* No Connect for someone off the AI Gateway: this says why, and a connection they already hold keeps Disconnect. */}
      {microsoft !== null && !microsoft.connectable ? <p className="basis-full text-pretty text-[13px] text-asst-muted">{MICROSOFT_UNAVAILABLE}</p> : null}
      {/* A connect that came back without a connection says so here, from the address it returned to. */}
      {microsoft?.connectable && !microsoft.stored && isConnectOutcome(outcome) ? (
        <p role="status" className="basis-full text-pretty text-[13px] text-asst-warn">
          {CONNECT_OUTCOME_WORDS[outcome]}
        </p>
      ) : null}
    </li>
  );
}

/** Whether the page passed any sign-in, Microsoft 365 included, saved credential, or a reason it has none to show. */
export function hasConnections(view: ConnectionsView): boolean {
  const tokens = view.tokens;
  return (
    view.list.length > 0 ||
    view.microsoft !== null ||
    view.unavailable !== null ||
    (tokens !== undefined && (tokens.rows.length > 0 || tokens.unavailable !== null))
  );
}

/**
 * Every service the assistant works with, one row each, whichever way it is connected: a sign-in the assistant makes,
 * a token the person pastes, or Microsoft 365's own sign-in.
 */
export function Connections({ view }: { view: ConnectionsView }) {
  // Said by the section rather than the row: a removed credential that cannot be pasted has no row once it is gone.
  const [said, setSaid] = useState<string | null>(null);
  const rows = connectionRows(view.list, view.access, view.tokens?.rows ?? [], view.microsoft, view.route);
  return (
    <section aria-labelledby="assistant-settings-connections" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-connections" className="text-sm font-semibold">
        Connections
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        The services your assistant works with. Connect one, paste a token your assistant asked for, or remove one it has saved. A saved value is never shown
        again.
      </p>
      {view.warning === null ? null : (
        <div className="flex flex-col gap-1 rounded-[10px] border border-asst-warn bg-asst-raised px-3.5 py-3">
          <p className="text-[13px] font-semibold text-asst-text">{view.warning}</p>
          {/*
           * The list says where each sign-in stands and nothing more, so this says where to go and not what will
           * be there. What is above the chats is whichever ask applies — the accounts to connect on a first visit, a
           * code to type, or a lapsed sign-in to ask for again — and promising one of the three would be wrong for
           * the other two.
           */}
          <p className="text-pretty text-[13px] text-asst-body">
            Your assistant cannot use these until you have signed in. Close this and the message above your chats takes you to them. You can carry on chatting
            either way.
          </p>
        </div>
      )}
      {/* Two reads that fail apart: the sign-ins the assistant asks for, and the credentials saved for the person. */}
      {view.unavailable === null ? null : <p className="text-[13px] text-asst-error">{view.unavailable}</p>}
      {view.tokens?.unavailable == null ? null : <p className="text-[13px] text-asst-error">Your credentials cannot be shown: {view.tokens.unavailable}</p>}
      {said === null ? null : (
        <p role="status" className="text-[13px] text-asst-ok">
          {said}
        </p>
      )}
      {rows.length === 0 ? null : (
        <ul aria-label="Connections" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
          {rows.map((row) => (
            <Row
              key={row.key}
              row={row}
              connect={view.connect}
              tokens={view.tokens}
              login={row.signIn === null ? undefined : view.logins.find((login) => login.kind === row.signIn?.kind)}
              now={view.now}
              held={awaitsGithub(row.key, view.list)}
              onSaid={setSaid}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
