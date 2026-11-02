"use client";

import { useId, useState } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { useSettingsData } from "@/components/assistant/useSettingsData";
import { MAX_GIT_EMAIL_LENGTH, MAX_GIT_NAME_CHARACTERS } from "@/credentials/git-identity";
import type { GitIdentitySettings } from "@/web/data";

/**
 * The person's optional override of the name and email their agents commit as: the `git_identity` credential, read
 * through `readGitIdentity` once the section opens and written by `saveGitIdentity` and `clearGitIdentity`. Whether a
 * value is acceptable is `checkGitIdentity`'s decision alone, and `ActionForm` shows its words.
 */
export interface AssistantGitIdentity {
  load: () => Promise<GitIdentitySettings>;
  save: FormAction;
  clear: FormAction;
}

const FIELD =
  "block w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 text-[13px] text-asst-text outline-hidden focus:border-asst-accent-line";

function Form({
  git,
  settings,
  onSaved,
  onCleared
}: {
  git: AssistantGitIdentity;
  settings: Extract<GitIdentitySettings, { available: true }>;
  onSaved: () => void;
  onCleared: (confirmation: string | undefined) => void;
}) {
  const id = useId();
  // The person's own from the first read on, so a re-read after a save never replaces what they are typing.
  const [name, setName] = useState(settings.identity.name ?? "");
  const [email, setEmail] = useState(settings.identity.email ?? "");
  return (
    <>
      <ActionForm action={git.save} label="Save your git identity" keepValues onSuccess={onSaved} className="flex flex-col gap-2">
        <label htmlFor={`${id}-name`} className="text-[13px] font-medium">
          Name
        </label>
        <input
          id={`${id}-name`}
          name="name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
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
          onChange={(event) => setEmail(event.target.value)}
          maxLength={MAX_GIT_EMAIL_LENGTH}
          autoComplete="email"
          spellCheck={false}
          className={FIELD}
        />
        <button
          type="submit"
          className="self-start rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover"
        >
          Save your git identity
        </button>
      </ActionForm>
      {settings.stored ? (
        <ActionForm
          action={git.clear}
          label="Go back to the default git identity"
          onSuccess={(result: { confirmation?: string }) => {
            setName("");
            setEmail("");
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
  // The clear's confirmation is said here, since its form goes once nothing is stored.
  const [said, setSaid] = useState<string | null>(null);
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
          onSaved={() => {
            setSaid(null);
            reload();
          }}
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
