"use client";

import { useId } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { MAX_GIT_EMAIL_LENGTH, MAX_GIT_NAME_CHARACTERS } from "@/credentials/git-identity";
import type { GitIdentitySettings } from "@/web/data";

/**
 * The person's optional override of the name and email their agents commit as: the `git_identity` credential
 * `gitIdentitySettings` reads, and the same two actions `/hub/virtual` posts to. Whether a value is acceptable is
 * `checkGitIdentity`'s decision alone, and `ActionForm` shows its words.
 */
export interface AssistantGitIdentity {
  settings: GitIdentitySettings;
  save: FormAction;
  clear: FormAction;
}

const FIELD =
  "block w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 text-[13px] text-asst-text outline-hidden focus:border-asst-accent-line";

function Form({ git }: { git: AssistantGitIdentity & { settings: Extract<GitIdentitySettings, { available: true }> } }) {
  const id = useId();
  const { stored, identity } = git.settings;
  const { name = "", email = "" } = identity;
  return (
    <>
      {/* Keyed on what is stored, so the fields show it again after a save or a clear. */}
      <ActionForm key={`${stored}|${name}|${email}`} action={git.save} label="Save your git identity" keepValues className="flex flex-col gap-2">
        <label htmlFor={`${id}-name`} className="text-[13px] font-medium">
          Name
        </label>
        <input id={`${id}-name`} name="name" type="text" defaultValue={name} maxLength={MAX_GIT_NAME_CHARACTERS} autoComplete="name" className={FIELD} />
        <label htmlFor={`${id}-email`} className="text-[13px] font-medium">
          Email
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          defaultValue={email}
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
      {stored ? (
        <ActionForm action={git.clear} label="Go back to the default git identity">
          <button type="submit" className="text-xs text-asst-muted underline hover:text-asst-text">
            Go back to the default
          </button>
        </ActionForm>
      ) : null}
    </>
  );
}

export function GitIdentity({ git }: { git: AssistantGitIdentity }) {
  const settings = git.settings;
  return (
    <section aria-labelledby="assistant-settings-git" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-git" className="text-sm font-semibold">
        Git identity
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Commits your assistant makes use your HMCTS email if it is on your GitHub account, and your GitHub noreply address if not. Set a name or an email here
        to use those instead. Your assistant uses a change from the next time it restarts.
      </p>
      {settings.available ? (
        <Form git={{ ...git, settings }} />
      ) : (
        <p className="text-[13px] text-asst-error">Your git identity cannot be shown: {settings.reason}</p>
      )}
    </section>
  );
}
