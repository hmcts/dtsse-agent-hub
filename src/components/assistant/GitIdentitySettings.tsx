"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { useSettingsData } from "@/components/assistant/useSettingsData";
import { useSettingsDraft, useSettingsSaves } from "@/components/assistant/useSettingsDraft";
import { MAX_GIT_EMAIL_LENGTH, MAX_GIT_NAME_CHARACTERS } from "@/credentials/git-identity";
import type { GitIdentitySettings } from "@/web/data";

/**
 * The person's optional override of the name and email their agents commit as: the `git_identity` credential, read
 * through `readGitIdentity` once the section opens, saved by the dialog's Save through `saveGitIdentity`, and cleared
 * by `clearGitIdentity`. Whether a
 * value is acceptable is `checkGitIdentity`'s decision alone, and `ActionForm` shows its words.
 */
export interface AssistantGitIdentity {
  load: () => Promise<GitIdentitySettings>;
  save: FormAction;
  clear: FormAction;
}

const FIELD =
  "block w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 text-[13px] text-asst-text outline-hidden focus:border-asst-accent-line";

function sameIdentity(a: { name: string; email: string }, b: { name: string; email: string }): boolean {
  return a.name === b.name && a.email === b.email;
}

function Form({
  git,
  settings,
  onCleared
}: {
  git: AssistantGitIdentity;
  settings: Extract<GitIdentitySettings, { available: true }>;
  onCleared: (confirmation: string | undefined) => void;
}) {
  const id = useId();
  // Held by the dialog from the first read on, so a re-read after a save never replaces what the person is typing.
  const draft = useSettingsDraft("git", { name: settings.identity.name ?? "", email: settings.identity.email ?? "" }, sameIdentity);
  const { name, email } = draft.value;
  return (
    <>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-name`} className="text-[13px] font-medium">
          Name
        </label>
        <input
          id={`${id}-name`}
          name="name"
          type="text"
          value={name}
          onChange={(event) => draft.set({ name: event.target.value, email })}
          maxLength={MAX_GIT_NAME_CHARACTERS}
          autoComplete="name"
          className={FIELD}
        />
        <label htmlFor={`${id}-email`} className="text-[13px] font-medium">
          Email
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          value={email}
          onChange={(event) => draft.set({ name, email: event.target.value })}
          maxLength={MAX_GIT_EMAIL_LENGTH}
          autoComplete="email"
          spellCheck={false}
          className={FIELD}
        />
        {draft.error === null ? null : (
          <p role="alert" className="text-xs text-asst-error">
            {draft.error}
          </p>
        )}
      </div>
      {settings.stored ? (
        <ActionForm
          action={git.clear}
          label="Go back to the default git identity"
          onSuccess={(result: { confirmation?: string }) => {
            draft.settle({ name: "", email: "" });
            onCleared(result.confirmation);
          }}
        >
          <button type="submit" className="text-xs text-asst-muted underline hover:text-asst-text">
            Go back to the default
          </button>
        </ActionForm>
      ) : null}
    </>
  );
}

export function GitIdentity({ git }: { git: AssistantGitIdentity }) {
  const { data: settings, failed, reload } = useSettingsData("git", git.load);
  const saves = useSettingsSaves();
  // The clear's confirmation is said here, since its form goes once nothing is stored.
  const [said, setSaid] = useState<string | null>(null);
  const seen = useRef(saves);
  // Read again after the dialog's Save, which may have stored this section's draft: what is stored is what the
  // "Go back to the default" beside the fields depends on.
  useEffect(() => {
    if (seen.current !== saves) {
      seen.current = saves;
      setSaid(null);
      reload();
    }
  }, [saves, reload]);
  return (
    <section aria-labelledby="assistant-settings-git" aria-busy={settings === undefined && !failed} className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-git" className="text-sm font-semibold">
        Git identity
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Commits your assistant makes use your HMCTS email if it is on your GitHub account, and your GitHub noreply address if not. Set a name or an email here
        to use those instead. Your assistant uses a change from the next time it restarts.
      </p>
      {said === null ? null : (
        <p role="status" className="text-[13px] text-asst-ok">
          {said}
        </p>
      )}
      {failed ? (
        <p className="text-[13px] text-asst-error">Your git identity could not be read. Close settings and open them again.</p>
      ) : settings === undefined ? (
        <p className="text-[13px] text-asst-muted">Reading your git identity…</p>
      ) : settings.available ? (
        <Form
          git={git}
          settings={settings}
          onCleared={(confirmation) => {
            setSaid(confirmation ?? null);
            reload();
          }}
        />
      ) : (
        <p className="text-[13px] text-asst-error">Your git identity cannot be shown: {settings.reason}</p>
      )}
    </section>
  );
}
