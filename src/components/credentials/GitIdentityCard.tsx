import { ActionForm, type FormAction } from "@/components/ActionForm";
import { EmptyState } from "@/components/EmptyState";
import { Section } from "@/components/Section";
import { MAX_GIT_EMAIL_LENGTH, MAX_GIT_NAME_CHARACTERS } from "@/credentials/git-identity";
import type { GitIdentitySettings } from "@/web/data";

export interface GitIdentityActions {
  save: FormAction;
  clear: FormAction;
}

const INPUT = "mt-1 w-96 max-w-full rounded-md border border-hub-line bg-hub-pane px-2 py-1 text-sm text-hub-text";
const BUTTON = "rounded bg-[#007a5a] px-3 py-1 text-sm font-medium text-white hover:bg-[#148567]";

/** The viewer's optional override of the git identity their virtual agents commit as. */
export function GitIdentityCard({ settings, actions }: { settings: GitIdentitySettings; actions: GitIdentityActions }) {
  if (!settings.available) {
    return <EmptyState message="Your git identity is unavailable" detail={settings.reason} />;
  }
  const { name = "", email = "" } = settings.identity;
  return (
    <Section heading="Git identity" detail={settings.stored ? "Overridden" : "Default"}>
      <div className="space-y-3 text-sm">
        <p className="max-w-3xl text-hub-muted">
          Commits from your virtual agents use your HMCTS email if it&apos;s on your GitHub account, otherwise your GitHub noreply address. Set these to
          override.
        </p>
        {/* Keyed on what is stored, so the fields show it again after a save or a clear. */}
        <ActionForm
          key={`${settings.stored}|${name}|${email}`}
          action={actions.save}
          label="Save your git identity"
          keepValues
          className="flex flex-wrap items-end gap-3"
        >
          <label className="block">
            <span className="block text-hub-text">Name</span>
            <input name="name" type="text" defaultValue={name} maxLength={MAX_GIT_NAME_CHARACTERS} autoComplete="name" className={INPUT} />
          </label>
          <label className="block">
            <span className="block text-hub-text">Email</span>
            <input name="email" type="email" defaultValue={email} maxLength={MAX_GIT_EMAIL_LENGTH} autoComplete="email" spellCheck={false} className={INPUT} />
          </label>
          <button type="submit" className={BUTTON}>
            Save
          </button>
        </ActionForm>
        {settings.stored ? (
          <ActionForm action={actions.clear} label="Clear your git identity">
            <button type="submit" className="text-xs text-red-300 hover:text-red-200">
              Clear
            </button>
          </ActionForm>
        ) : null}
      </div>
    </Section>
  );
}
