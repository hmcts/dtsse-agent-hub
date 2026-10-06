"use client";

import { useId, useState } from "react";
import { ActionForm, type FormAction } from "@/components/ActionForm";
import { EmptyState } from "@/components/EmptyState";
import { Panel } from "@/components/Section";
import { Timestamp } from "@/components/time/Timestamp";
import { claudeMdLength, DEFAULT_CLAUDE_MD, MAX_CLAUDE_MD_CHARACTERS } from "@/credentials/claude-md";
import type { ClaudeMdSettings } from "@/web/data";

export interface ClaudeMdActions {
  save: FormAction;
  reset: FormAction;
}

export const CLAUDE_MD_ANCHOR = "claude-md";

const BUTTON = "rounded bg-[#007a5a] px-3 py-1 text-sm font-medium text-white hover:bg-[#148567]";

function count(value: number): string {
  return value.toLocaleString("en-GB");
}

/**
 * The editor. The page re-renders with the stored text after a save, a reset or a change from another tab; that
 * replaces the draft only while it matches the text last shown, so a refresh never throws away what someone is
 * typing. A save or a reset leaves the draft already holding what the refresh will bring.
 */
function ClaudeMdEditor({ stored, text, updatedAt, actions }: { stored: boolean; text: string; updatedAt: string | null; actions: ClaudeMdActions }) {
  const [draft, setDraft] = useState(text);
  const [shown, setShown] = useState(text);
  if (text !== shown) {
    setShown(text);
    if (draft === shown) {
      setDraft(text);
    }
  }
  const id = useId();
  const length = claudeMdLength(draft);
  const over = length - MAX_CLAUDE_MD_CHARACTERS;
  return (
    <Panel>
      <div className="space-y-3 p-4 text-sm">
        <ActionForm action={actions.save} label="Save your CLAUDE.md" keepValues className="space-y-3">
          <label htmlFor={`${id}-text`} className="block font-bold text-white">
            CLAUDE.md
          </label>
          <p id={`${id}-hint`} className="text-hub-muted">
            {stored && updatedAt !== null ? (
              <>
                Last saved <Timestamp iso={updatedAt} />.
              </>
            ) : (
              "This is the default. Nothing of yours is stored yet."
            )}
          </p>
          <textarea
            id={`${id}-text`}
            name="value"
            rows={14}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-describedby={`${id}-hint ${id}-count`}
            aria-invalid={over > 0}
            className="block w-full max-w-4xl rounded-md border border-hub-line bg-hub-pane px-2 py-1 font-mono text-sm text-hub-text"
          />
          <p id={`${id}-count`} className={over > 0 ? "text-red-300" : "text-hub-muted"}>
            {count(length)} of {count(MAX_CLAUDE_MD_CHARACTERS)} characters
            {over > 0 ? `: ${count(over)} too many` : null}
          </p>
          <button type="submit" className={BUTTON}>
            Save
          </button>
        </ActionForm>
        {stored ? (
          <ActionForm action={actions.reset} label="Reset your CLAUDE.md to the default" onSuccess={() => setDraft(DEFAULT_CLAUDE_MD)}>
            <button type="submit" className="text-xs text-red-300 hover:text-red-200">
              Reset to default
            </button>
          </ActionForm>
        ) : null}
      </div>
    </Panel>
  );
}

/** The viewer's own CLAUDE.md, as a part of the virtual agents page. */
export function ClaudeMdSection({ settings, actions }: { settings: ClaudeMdSettings; actions: ClaudeMdActions }) {
  return (
    <section id={CLAUDE_MD_ANCHOR} aria-labelledby="claude-md-heading" className="scroll-mt-5 space-y-6">
      <div>
        <h2 id="claude-md-heading" className="text-lg font-bold text-white">
          Your CLAUDE.md
        </h2>
        <p className="max-w-3xl text-[13px] text-hub-muted">
          Written to <code className="font-mono">~/.claude/CLAUDE.md</code> in each of your virtual agents before Claude starts. Applies to all of them. Changes
          reach a running agent the next time its Claude starts.
        </p>
      </div>
      {settings.available ? (
        <ClaudeMdEditor stored={settings.stored} text={settings.text} updatedAt={settings.updatedAt} actions={actions} />
      ) : (
        <EmptyState message="Your CLAUDE.md is unavailable" detail={settings.reason} />
      )}
    </section>
  );
}
