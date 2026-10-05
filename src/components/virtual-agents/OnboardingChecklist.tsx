import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Section } from "@/components/Section";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { LoginView } from "@/virtual-agents/logins";
import { LoginCountdown } from "./LoginCountdown";

const TITLES: Record<CredentialKind, string> = {
  github: "GitHub",
  azure: "Azure",
  claude: "Claude"
};

const INPUT = "mt-1 w-96 max-w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 font-mono text-sm text-hub-text";
const BUTTON = "rounded bg-[#007a5a] px-3 py-1 text-sm font-medium text-white hover:bg-[#148567]";

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
          <a href={login.verificationUri} target="_blank" rel="noreferrer noopener" className="text-hub-link underline">
            {login.verificationUri}
          </a>{" "}
          and enter this code <LoginCountdown expiresAt={login.expiresAt} />:
        </p>
        <p>
          <span className="sr-only">{title} device code: </span>
          <code className="inline-block rounded-md border border-hub-line bg-hub-raised px-3 py-1 font-mono text-lg tracking-widest text-white">
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
        <ActionForm action={paste} label={`Paste the ${title} code`} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={virtualAgentId} />
          <input type="hidden" name="kind" value={login.kind} />
          <label className="block">
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

function Card({
  virtualAgentId,
  kind,
  status,
  login,
  paste,
  now
}: {
  virtualAgentId: string;
  kind: CredentialKind;
  status: CredentialStatus | undefined;
  login: LoginView | undefined;
  paste: FormAction;
  now: number;
}) {
  const state = checklistState(status?.stored === true, login, now);
  const detail = { stored: "✓ Stored", login: "Sign-in waiting for you", waiting: "Waiting for your virtual agent to ask" }[state];
  return (
    <li className="space-y-2 border-b border-hub-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-sm font-bold text-white">{TITLES[kind]}</h3>
        <span className={`text-xs ${state === "stored" ? "text-green-300" : "text-hub-muted"}`}>{detail}</span>
        {state === "stored" && status?.accountLabel ? <span className="text-xs text-hub-muted">for {status.accountLabel}</span> : null}
      </div>
      {state === "login" && login !== undefined ? <PendingLogin virtualAgentId={virtualAgentId} login={login} paste={paste} /> : null}
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
 * with its code or a box to paste one into, or nothing yet. Only the owner ever sees this page.
 */
export function OnboardingChecklist({
  virtualAgentId,
  needed,
  statuses,
  logins,
  paste,
  now,
  unavailable
}: {
  virtualAgentId: string;
  needed: CredentialKind[];
  statuses: CredentialStatus[];
  logins: LoginView[];
  paste: FormAction;
  now: number;
  unavailable?: string;
}) {
  return (
    <Section
      heading="Sign-ins"
      detail={`${needed.filter((kind) => statuses.find((status) => status.kind === kind)?.stored).length} of ${needed.length} stored`}
    >
      {unavailable ? <p className="pb-3 text-sm text-hub-muted">{unavailable}</p> : null}
      <ul aria-label="Sign-ins" className="-mx-4 -mb-4">
        {needed.map((kind) => (
          <Card
            key={kind}
            virtualAgentId={virtualAgentId}
            kind={kind}
            status={statuses.find((status) => status.kind === kind)}
            login={logins.find((login) => login.kind === kind)}
            paste={paste}
            now={now}
          />
        ))}
      </ul>
    </Section>
  );
}
