"use client";

import { useId, useState } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { Timestamp } from "@/components/time/Timestamp";
import { claudeMdLength, DEFAULT_CLAUDE_MD, MAX_CLAUDE_MD_CHARACTERS } from "@/credentials/claude-md";
import type { ClaudeMdSettings } from "@/web/data";

/**
 * The person's own CLAUDE.md as the Assistant's settings show it: the one stored value `claudeMdSettings` reads, and
 * the one pair of actions the hub's virtual agents page posts to, in the Assistant's own colours. Nothing here is a
 * second place the value lives, and the length and content rules are `credentials/claude-md.ts`'s throughout.
 */
export interface AssistantClaudeMd {
  settings: ClaudeMdSettings;
  save: FormAction;
  reset: FormAction;
}

type ReadableClaudeMd = Extract<ClaudeMdSettings, { available: true }>;

const FIELD =
  "block w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 font-plex-mono text-[13px] leading-5 text-asst-text outline-hidden focus:border-asst-accent-line";

function count(value: number): string {
  return value.toLocaleString("en-GB");
}

/**
 * The editor. The draft starts from what the server sent and is the person's from then on: the dialog unmounts when
 * it closes, so it reopens with whatever is stored, and a re-render while someone is typing never replaces their
 * text. A reset leaves the draft holding the default, which is what the pod will be given.
 *
 * The count uses `claudeMdLength` and `MAX_CLAUDE_MD_CHARACTERS`, so the number shown is the one the store checks
 * against. Whether the text is acceptable is the store's decision alone, and `ActionForm` shows its words.
 */
function Editor({ view, save, reset }: { view: ReadableClaudeMd; save: FormAction; reset: FormAction }) {
  const [draft, setDraft] = useState(view.text);
  const id = useId();
  const length = claudeMdLength(draft);
  const over = length - MAX_CLAUDE_MD_CHARACTERS;
  return (
    <>
      <ActionForm action={save} label="Save your CLAUDE.md" keepValues className="flex flex-col gap-2">
        <label htmlFor={`${id}-text`} className="text-[13px] font-medium">
          CLAUDE.md
        </label>
        <p id={`${id}-hint`} className="text-[13px] text-asst-muted">
          {view.stored && view.updatedAt !== null ? (
            <>
              Last saved <Timestamp iso={view.updatedAt} />.
            </>
          ) : (
            "This is the default. Nothing of yours is stored yet."
          )}
        </p>
        <textarea
          id={`${id}-text`}
          name="value"
          rows={8}
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-describedby={`${id}-hint ${id}-count`}
          aria-invalid={over > 0}
          className={FIELD}
        />
        <p id={`${id}-count`} className={`text-xs ${over > 0 ? "text-asst-error" : "text-asst-muted"}`}>
          {count(length)} of {count(MAX_CLAUDE_MD_CHARACTERS)} characters
          {over > 0 ? `: ${count(over)} too many` : null}
        </p>
        <button
          type="submit"
          className="self-start rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover"
        >
          Save your CLAUDE.md
        </button>
      </ActionForm>
      {view.stored ? (
        <ActionForm action={reset} label="Reset your CLAUDE.md to the default" onSuccess={() => setDraft(DEFAULT_CLAUDE_MD)}>
          <button type="submit" className="text-xs text-asst-muted underline hover:text-asst-text">
            Reset to the default
          </button>
        </ActionForm>
      ) : null}
    </>
  );
}

/**
 * The CLAUDE.md section of the Assistant's settings. It says in plain words that the notes are the person's own and
 * are used by all of their chats rather than the one they are in, and that a chat already running keeps the notes it
 * started with: every pod writes the file before each start of Claude, so a change reaches a chat when its session
 * next starts, not while one is in progress.
 */
export function ClaudeMd({ claudeMd }: { claudeMd: AssistantClaudeMd }) {
  return (
    <section aria-labelledby="assistant-settings-claude-md" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-claude-md" className="text-sm font-semibold">
        Your CLAUDE.md
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Notes your assistant reads before it starts work: what you work on, and how you like things done. They apply to all of your chats, not only this one. A
        chat picks up a change when its session next starts, so a chat already running keeps the notes it started with.
      </p>
      {claudeMd.settings.available ? (
        <Editor view={claudeMd.settings} save={claudeMd.save} reset={claudeMd.reset} />
      ) : (
        <p className="text-[13px] text-asst-error">Your CLAUDE.md cannot be shown: {claudeMd.settings.reason}</p>
      )}
    </section>
  );
}
