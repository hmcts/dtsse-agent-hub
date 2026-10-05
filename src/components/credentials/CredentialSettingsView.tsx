import { ActionForm, type FormAction } from "@/components/ActionForm";
import { EmptyState } from "@/components/EmptyState";
import { Section } from "@/components/Section";
import { Timestamp } from "@/components/time/Timestamp";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus, CredentialVia } from "@/credentials/store";
import type { ModelRoute } from "@/viewer/identity";
import type { CredentialSettings } from "@/web/data";

export interface CredentialActions {
  save: FormAction;
  remove: FormAction;
}

const TITLES: Record<CredentialKind, string> = {
  github: "GitHub token",
  azure: "Azure sign-in",
  claude: "Claude token"
};

const VIA: Record<CredentialVia, string> = {
  web: "on this page",
  cli: "from the command line",
  pod: "by your virtual agent"
};

const INPUT = "mt-1 w-96 max-w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 font-mono text-sm text-hub-text";
const BUTTON = "rounded bg-[#007a5a] px-3 py-1 text-sm font-medium text-white hover:bg-[#148567]";

export function ModelRouteNotice({ route }: { route: ModelRoute }) {
  return (
    <Section heading="Model" detail={route === "gateway" ? "HMCTS AI gateway" : "Your own Claude licence"}>
      <p className="text-sm text-hub-text">
        {route === "gateway" ? (
          "Your virtual agents use the HMCTS AI gateway, so they need no Claude token of yours."
        ) : (
          <>
            Your virtual agents use your own Claude licence, so they need the Claude token <code className="font-mono">claude setup-token</code> prints.
          </>
        )}
      </p>
    </Section>
  );
}

/** Why a kind cannot be pasted here, or `undefined` when it can. */
function notPasteable(kind: CredentialKind, route: ModelRoute): string | undefined {
  if (kind === "azure") {
    return "This comes from your virtual agent's own Azure device-code sign-in, and cannot be pasted here.";
  }
  if (kind === "claude" && route === "gateway") {
    return "Not needed: your virtual agents use the HMCTS AI gateway.";
  }
  return undefined;
}

export function CredentialCard({ status, route, actions }: { status: CredentialStatus; route: ModelRoute; actions: CredentialActions }) {
  const title = TITLES[status.kind];
  const unpasteable = notPasteable(status.kind, route);
  return (
    <Section heading={title} detail={status.stored ? "Stored" : "Not stored"}>
      <div className="space-y-3 text-sm">
        {status.stored ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-hub-text">
              {status.updatedAt ? (
                <>
                  Last saved <Timestamp iso={status.updatedAt} />
                  {status.updatedVia ? ` ${VIA[status.updatedVia]}` : null}
                </>
              ) : null}
              {status.accountLabel ? <span className="ml-2 text-hub-muted">for {status.accountLabel}</span> : null}
            </p>
            <ActionForm action={actions.remove} label={`Delete ${title}`} className="ml-auto">
              <input type="hidden" name="kind" value={status.kind} />
              <button type="submit" className="text-xs text-red-300 hover:text-red-200">
                Delete
              </button>
            </ActionForm>
          </div>
        ) : null}
        {unpasteable === undefined ? (
          <ActionForm action={actions.save} label={`Save ${title}`} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="kind" value={status.kind} />
            <label className="block">
              <span className="block text-hub-text">{status.stored ? `Replace your ${title}` : `Paste a ${title}`}</span>
              <input name="value" type="password" required autoComplete="off" spellCheck={false} className={INPUT} />
            </label>
            <button type="submit" className={BUTTON}>
              Save
            </button>
          </ActionForm>
        ) : (
          <p className="text-hub-muted">{unpasteable}</p>
        )}
      </div>
    </Section>
  );
}

/** The whole page body below the header: the model route, then each credential, or why there are none here. */
export function CredentialSettingsView({ settings, actions }: { settings: CredentialSettings; actions: CredentialActions }) {
  return (
    <>
      <ModelRouteNotice route={settings.modelRoute} />
      {settings.available ? (
        <>
          <p className="max-w-3xl text-[15px] text-hub-muted">
            You normally set these up on a virtual agent's page, by signing in with device codes, so pasting a token here is optional. A stored credential can
            never be read back, by you or anyone else, through this page or any API: you can only replace or delete it.
          </p>
          {settings.statuses.map((status) => (
            <CredentialCard key={status.kind} status={status} route={settings.modelRoute} actions={actions} />
          ))}
        </>
      ) : (
        <EmptyState message="Credentials unavailable" detail={settings.reason} />
      )}
    </>
  );
}
