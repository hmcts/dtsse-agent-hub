"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Connection } from "@/assistant/connections";
import { ActionForm, type FormAction } from "@/components/ActionForm";

/**
 * The tokens the person pastes rather than signs in for — a Jenkins API token, and a Claude token on their own
 * licence — with a way to replace or remove each: `saveCredential` and `removeCredential`, which `/hub/virtual`
 * posts to as well. A stored value is never shown. Which kinds are pasted is `CONNECTORS`'s `paste`.
 */
export interface AssistantTokens {
  save: FormAction;
  remove: FormAction;
}

const FIELD =
  "block w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 font-plex-mono text-[13px] text-asst-text outline-hidden focus:border-asst-accent-line";
const SECONDARY = "rounded-[10px] border border-asst-strong px-3 py-1.5 text-[13px] hover:bg-asst-hover";

/** The rows this section is about: a pasted token's, out of the Connections list. */
export function pastedTokens(list: readonly Connection[]): Connection[] {
  return list.filter((row) => row.paste !== null);
}

/** What removing a token ends, said before the person commits. A Claude token is listed only where it is what the agents reach Claude with. */
function removeQuestion(row: Connection): string {
  return row.kind === "claude"
    ? `Remove your ${row.paste}? Your assistant reaches Claude with it, so it cannot answer again until you paste a new one.`
    : `Remove your ${row.paste}? Your assistant stops using it the next time it starts.`;
}

function Replace({ row, save, onDone, onSaved }: { row: Connection; save: FormAction; onDone: () => void; onSaved: () => void }) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  return (
    <ActionForm action={save} label={`Save your ${row.paste}`} onSuccess={onSaved} className="flex basis-full flex-col gap-2 pt-1">
      <input type="hidden" name="kind" value={row.kind} />
      <label htmlFor={`${id}-value`} className="text-[13px] font-medium">
        {row.stored ? `New ${row.paste}` : row.paste}
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

function Remove({ row, remove, onDone, onRemoved }: { row: Connection; remove: FormAction; onDone: () => void; onRemoved: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirm.current?.focus();
  }, []);

  return (
    <ActionForm action={remove} label={`Remove your ${row.paste}`} onSuccess={onRemoved} className="flex basis-full flex-col gap-2 pt-1">
      <input type="hidden" name="kind" value={row.kind} />
      <p className="text-pretty text-[13px] font-semibold">{removeQuestion(row)}</p>
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

function Token({ row, tokens }: { row: Connection; tokens: AssistantTokens }) {
  const [doing, setDoing] = useState<"replace" | "remove" | null>(null);
  // Said in the row rather than in the form, which closes on success.
  const [done, setDone] = useState<string | null>(null);
  const finish = (said: string) => () => {
    setDoing(null);
    setDone(said);
  };
  const start = (what: "replace" | "remove") => () => {
    setDone(null);
    setDoing(what);
  };
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-asst-line px-3.5 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm font-medium">{row.paste}</span>
        <span className="truncate text-xs text-asst-muted">{row.stored ? "Saved" : "Not saved"}</span>
        {done === null ? null : (
          <span role="status" className="text-xs text-asst-ok">
            {done}
          </span>
        )}
      </div>
      {doing === null ? (
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={start("replace")} aria-label={`${row.stored ? "Replace" : "Add"} your ${row.paste}`} className={SECONDARY}>
            {row.stored ? "Replace" : "Add"}
          </button>
          {row.stored ? (
            <button type="button" onClick={start("remove")} aria-label={`Remove your ${row.paste}`} className={SECONDARY}>
              Remove
            </button>
          ) : null}
        </div>
      ) : doing === "replace" ? (
        <Replace row={row} save={tokens.save} onDone={() => setDoing(null)} onSaved={finish(`Your ${row.paste} is saved`)} />
      ) : (
        <Remove row={row} remove={tokens.remove} onDone={() => setDoing(null)} onRemoved={finish(`Your ${row.paste} is removed`)} />
      )}
    </li>
  );
}

export function TokenSettings({ list, tokens }: { list: readonly Connection[]; tokens: AssistantTokens }) {
  const rows = pastedTokens(list);
  return (
    <section aria-labelledby="assistant-settings-tokens" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-tokens" className="text-sm font-semibold">
        Tokens
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">Tokens you paste rather than sign in for. A saved token is never shown again.</p>
      <ul aria-label="Tokens" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
        {rows.map((row) => (
          <Token key={row.kind} row={row} tokens={tokens} />
        ))}
      </ul>
    </section>
  );
}
