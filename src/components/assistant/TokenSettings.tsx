"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { SavedCredential } from "@/assistant/saved-credentials";
import { ActionForm, type FormAction } from "@/components/ActionForm";

/**
 * The person's saved credentials: a box to paste each kind `saveCredential` accepts, and a way to remove each one
 * stored, through `removeCredential`. Which kinds are which, and what removing each ends, is `savedCredentials`'s.
 * A stored value is never shown.
 */
export interface AssistantTokens {
  rows: SavedCredential[];
  /** Why the hub cannot read the person's credentials, which is not the same as their having none. */
  unavailable: string | null;
  save: FormAction;
  remove: FormAction;
}

const FIELD =
  "block w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 font-plex-mono text-[13px] text-asst-text outline-hidden focus:border-asst-accent-line";
const SECONDARY = "rounded-[10px] border border-asst-strong px-3 py-1.5 text-[13px] hover:bg-asst-hover";

function Replace({ row, save, onDone, onSaved }: { row: SavedCredential; save: FormAction; onDone: () => void; onSaved: () => void }) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  return (
    <ActionForm action={save} label={`Save your ${row.title}`} onSuccess={onSaved} className="flex basis-full flex-col gap-2 pt-1">
      <input type="hidden" name="kind" value={row.kind} />
      <label htmlFor={`${id}-value`} className="text-[13px] font-medium">
        {row.stored ? `New ${row.title}` : row.title}
      </label>
      <input ref={field} id={`${id}-value`} name="value" type="password" required autoComplete="off" spellCheck={false} className={FIELD} />
      <div className="flex items-center gap-3">
        <button type="submit" className="rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover">
          Save
        </button>
        <button type="button" onClick={onDone} className="text-[13px] font-medium text-asst-muted hover:text-asst-text">
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

function Remove({ row, remove, onDone, onRemoved }: { row: SavedCredential; remove: FormAction; onDone: () => void; onRemoved: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirm.current?.focus();
  }, []);

  return (
    <ActionForm action={remove} label={`Remove your ${row.title}`} onSuccess={onRemoved} className="flex basis-full flex-col gap-2 pt-1">
      <input type="hidden" name="kind" value={row.kind} />
      <p className="text-pretty text-[13px] font-semibold">{row.removeQuestion}</p>
      <div className="flex items-center gap-3">
        <button ref={confirm} type="submit" className="rounded-[10px] bg-asst-error px-3.5 py-2 text-[13px] font-semibold text-asst-ink">
          Remove
        </button>
        <button type="button" onClick={onDone} className="text-[13px] font-medium text-asst-muted hover:text-asst-text">
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}

function Row({ row, tokens, onDone }: { row: SavedCredential; tokens: AssistantTokens; onDone: (said: string | null) => void }) {
  const [doing, setDoing] = useState<"replace" | "remove" | null>(null);
  const finish = (said: string) => () => {
    setDoing(null);
    onDone(said);
  };
  const start = (what: "replace" | "remove") => () => {
    onDone(null);
    setDoing(what);
  };
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-asst-line px-3.5 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium">{row.title}</span>
        <span className="truncate text-xs text-asst-muted">
          {row.stored ? "Saved" : "Not saved"}
          {row.accountLabel === null ? null : ` · ${row.accountLabel}`}
        </span>
      </div>
      {doing === null ? (
        <div className="flex shrink-0 gap-2">
          {row.pasteable ? (
            <button type="button" onClick={start("replace")} aria-label={`${row.stored ? "Replace" : "Add"} your ${row.title}`} className={SECONDARY}>
              {row.stored ? "Replace" : "Add"}
            </button>
          ) : null}
          {row.stored ? (
            <button type="button" onClick={start("remove")} aria-label={`Remove your ${row.title}`} className={SECONDARY}>
              Remove
            </button>
          ) : null}
        </div>
      ) : doing === "replace" ? (
        <Replace row={row} save={tokens.save} onDone={() => setDoing(null)} onSaved={finish(`Your ${row.title} is saved`)} />
      ) : (
        <Remove row={row} remove={tokens.remove} onDone={() => setDoing(null)} onRemoved={finish(`Your ${row.title} is removed`)} />
      )}
    </li>
  );
}

export function TokenSettings({ tokens }: { tokens: AssistantTokens }) {
  // Said by the section rather than the row: a removed credential that cannot be pasted has no row once it is gone.
  const [said, setSaid] = useState<string | null>(null);
  return (
    <section aria-labelledby="assistant-settings-tokens" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-tokens" className="text-sm font-semibold">
        Credentials
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Paste a token your assistant asked for, or remove one it has saved. A saved value is never shown again. Sign-ins your assistant makes for itself can
        only be removed here, not pasted.
      </p>
      {said === null ? null : (
        <p role="status" className="text-[13px] text-asst-ok">
          {said}
        </p>
      )}
      {tokens.unavailable === null ? (
        <ul aria-label="Credentials" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
          {tokens.rows.map((row) => (
            <Row key={row.kind} row={row} tokens={tokens} onDone={setSaid} />
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-asst-error">Your credentials cannot be shown: {tokens.unavailable}</p>
      )}
    </section>
  );
}
