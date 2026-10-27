"use client";

import { useEffect, useId, useRef, useState } from "react";
import { TEMPLATES, type Template } from "@/assistant/starters";
import { MAX_TEMPLATE_BODY, MAX_TEMPLATE_NAME, MAX_TEMPLATES, type SavedTemplate, TEMPLATES_FULL, templateLength } from "@/assistant/templates";
import { ActionForm, type FormAction } from "@/components/ActionForm";

/**
 * The person's own saved prompts as the Assistant's settings edit them: the list `assistantTemplates` reads and the
 * two actions that change it. The caps and every refusal are `src/assistant/templates.ts`'s, so the counts shown here
 * are the ones the store checks against and nothing is refused in words of this file's own.
 */
export interface AssistantTemplates {
  mine: readonly SavedTemplate[];
  save: FormAction;
  remove: FormAction;
}

const FIELD =
  "block w-full rounded-lg border border-asst-strong bg-asst-field px-2.5 py-2 text-[13px] leading-5 text-asst-text outline-none focus:border-asst-accent-line";

function count(value: number): string {
  return value.toLocaleString("en-GB");
}

/**
 * The name a copy of a built-in starts with. It cannot be the built-in's own, because `checkTemplate` refuses that, so
 * the person is handed one that saves as it is and can rename it before they do.
 */
export function copyName(built: Template): string {
  return `${built.name} (copy)`;
}

/** What the form is open on: nothing (adding), one of the person's own (editing), or a built-in being copied. */
type Target = { edit: string } | { copy: Template; nonce: number } | null;

/**
 * The one form, adding a template (empty, or started from a copy of a built-in) or replacing the one it was opened on.
 * It is remounted when the target changes —
 * see the `key` where it is rendered — so its fields are plain `useState` rather than anything that has to be put
 * back in step with the server's list. A save does *not* remount it: that would take the confirmation `ActionForm`
 * had just set with it, so adding clears its own fields instead and editing stays open on what was saved.
 *
 * The counts use `templateLength` and the `MAX_TEMPLATE_*` caps, so a person is told they are over before they submit
 * and the number they are shown is the number the store counts. Whether the value is acceptable is still the store's
 * decision alone, and `ActionForm` shows the words it refuses in.
 */
function Editor({
  template,
  copying = null,
  save,
  onCancel
}: {
  template: SavedTemplate | null;
  copying?: Template | null;
  save: FormAction;
  onCancel: () => void;
}) {
  const [name, setName] = useState(template?.name ?? (copying === null ? "" : copyName(copying)));
  const [body, setBody] = useState(template?.text ?? copying?.text ?? "");
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  // A copy is started from the built-in list below this form, so the field it filled is brought into view and focused
  // rather than left for the person to scroll back up and find.
  useEffect(() => {
    if (copying !== null) {
      nameRef.current?.focus();
    }
  }, [copying]);
  const overName = templateLength(name) - MAX_TEMPLATE_NAME;
  const length = templateLength(body);
  const over = length - MAX_TEMPLATE_BODY;
  return (
    <ActionForm
      action={save}
      label={template === null ? "Save a new template" : `Save your changes to ${template.name}`}
      keepValues
      onSuccess={
        template === null
          ? () => {
              setName("");
              setBody("");
            }
          : undefined
      }
      className="flex flex-col gap-2"
    >
      {template === null ? null : <input type="hidden" name="id" value={template.id} />}
      <label htmlFor={`${id}-name`} className="text-[13px] font-medium">
        Template name
      </label>
      <input
        id={`${id}-name`}
        ref={nameRef}
        name="name"
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-describedby={overName > 0 ? `${id}-name-count` : undefined}
        aria-invalid={overName > 0}
        className={FIELD}
      />
      {overName > 0 ? (
        <p id={`${id}-name-count`} className="text-xs text-asst-error">
          {count(overName)} characters too many; a name is at most {count(MAX_TEMPLATE_NAME)}
        </p>
      ) : null}
      <label htmlFor={`${id}-body`} className="text-[13px] font-medium">
        What it fills the message box with
      </label>
      <textarea
        id={`${id}-body`}
        name="body"
        rows={6}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-describedby={`${id}-body-count`}
        aria-invalid={over > 0}
        className={`${FIELD} font-plex-mono`}
      />
      <p id={`${id}-body-count`} className={`text-xs ${over > 0 ? "text-asst-error" : "text-asst-muted"}`}>
        {count(length)} of {count(MAX_TEMPLATE_BODY)} characters
        {over > 0 ? `: ${count(over)} too many` : null}
      </p>
      <div className="flex items-center gap-3">
        <button type="submit" className="rounded-[10px] bg-asst-accent px-3.5 py-2 text-[13px] font-semibold text-asst-ink hover:bg-asst-accent-hover">
          {template === null ? "Save template" : "Save changes"}
        </button>
        {template === null && copying === null ? null : (
          <button type="button" onClick={onCancel} className="text-xs text-asst-muted underline hover:text-asst-text">
            Cancel
          </button>
        )}
      </div>
    </ActionForm>
  );
}

/**
 * The templates section of the Assistant's settings: what the person has saved, the form that adds or changes one,
 * and the built-in templates they can read and copy into that form.
 *
 * It says in plain words that these sit beside the built-in templates rather than replacing them, because that is the
 * one thing the + menu cannot show — the menu is one list, the person's own at the top, and the built-in ones have no
 * Edit beside them to say which is which.
 *
 * At the cap the Add form is replaced by the store's own refusal rather than a submit that fails, and Edit still
 * works: being full is a reason not to keep another, not a reason to stop changing the ones you have.
 */
export function Templates({ templates }: { templates: AssistantTemplates }) {
  const { mine, save, remove } = templates;
  const [open, setOpen] = useState<Target>(null);
  // Derived from the server's list rather than held beside it, so a template deleted while it was open leaves this
  // null and the form is back to adding without anything having to notice the deletion.
  const target = open !== null && "edit" in open ? (mine.find((template) => template.id === open.edit) ?? null) : null;
  const copying = open !== null && "copy" in open ? open : null;
  const full = target === null && mine.length >= MAX_TEMPLATES;

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="assistant-settings-templates" className="flex flex-col gap-2.5">
        <h3 id="assistant-settings-templates" className="text-sm font-semibold">
          Your templates
        </h3>
        <p className="text-pretty text-[13px] text-asst-muted">
          Prompts you keep and reuse. They are offered in the + menu of every chat, above the built-in templates, and picking one fills the message box for you
          to finish.
        </p>
        {mine.length === 0 ? (
          <p className="text-[13px] text-asst-muted">You have not saved any yet.</p>
        ) : (
          <ul aria-label="Your templates" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
            {mine.map((template) => (
              <li key={template.id} className="flex items-start gap-3 border-b border-asst-line px-3.5 py-3 last:border-b-0">
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-sm font-medium">{template.name}</span>
                  <span className="truncate text-xs text-asst-muted">{template.text}</span>
                </div>
                <button
                  type="button"
                  aria-label={`Edit ${template.name}`}
                  onClick={() => setOpen({ edit: template.id })}
                  className="shrink-0 text-xs text-asst-muted underline hover:text-asst-text"
                >
                  Edit
                </button>
                <ActionForm action={remove} label={`Delete ${template.name}`} className="shrink-0">
                  <input type="hidden" name="id" value={template.id} />
                  <button type="submit" aria-label={`Delete ${template.name}`} className="text-xs text-asst-muted underline hover:text-asst-text">
                    Delete
                  </button>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-asst-muted">
          {count(mine.length)} of {count(MAX_TEMPLATES)} templates
        </p>
        {full ? (
          // The store's own sentence, so what the person reads here is what a POST that skipped this screen is told.
          <p className="text-[13px] text-asst-warn first-letter:uppercase">{TEMPLATES_FULL}</p>
        ) : (
          // The nonce is in the key so that every Copy remounts the form on the built-in, even a second Copy of the same one.
          <Editor
            key={target?.id ?? (copying === null ? "new" : `copy-${copying.nonce}`)}
            template={target}
            copying={copying?.copy ?? null}
            save={save}
            onCancel={() => setOpen(null)}
          />
        )}
      </section>
      <BuiltIns
        canCopy={mine.length < MAX_TEMPLATES}
        onCopy={(built) => setOpen((last) => ({ copy: built, nonce: (last !== null && "copy" in last ? last.nonce : 0) + 1 }))}
      />
    </div>
  );
}

/**
 * The built-in templates, read-only: each one's whole prompt behind a View, and a Copy that opens the form above on it
 * so the person can keep their own version. The + menu shows only their names, so this is the one place a person can
 * read what one fills the message box with before they pick it.
 *
 * At the cap there is no Copy, because the form it would open is replaced by the store's refusal.
 */
function BuiltIns({ canCopy, onCopy }: { canCopy: boolean; onCopy: (built: Template) => void }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const id = useId();
  return (
    <section aria-labelledby="assistant-settings-built-in" className="flex flex-col gap-2.5">
      <h3 id="assistant-settings-built-in" className="text-sm font-semibold">
        Built-in templates
      </h3>
      <p className="text-pretty text-[13px] text-asst-muted">
        Everyone has these, and they cannot be changed. Copy one to your templates to make your own version of it.
      </p>
      <ul aria-label="Built-in templates" className="flex flex-col overflow-hidden rounded-[10px] border border-asst-line">
        {TEMPLATES.map((built, index) => {
          const shown = viewing === built.name;
          const panel = `${id}-${index}`;
          return (
            <li key={built.name} className="flex flex-col gap-2 border-b border-asst-line px-3.5 py-3 last:border-b-0">
              <div className="flex items-start gap-3">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{built.name}</span>
                <button
                  type="button"
                  aria-label={`${shown ? "Hide" : "View"} ${built.name}`}
                  aria-expanded={shown}
                  aria-controls={panel}
                  onClick={() => setViewing(shown ? null : built.name)}
                  className="shrink-0 text-xs text-asst-muted underline hover:text-asst-text"
                >
                  {shown ? "Hide" : "View"}
                </button>
                {canCopy ? (
                  <button
                    type="button"
                    aria-label={`Copy ${built.name} to your templates`}
                    onClick={() => onCopy(built)}
                    className="shrink-0 text-xs text-asst-muted underline hover:text-asst-text"
                  >
                    Copy to my templates
                  </button>
                ) : null}
              </div>
              {/* Hidden rather than unmounted, so the View's aria-controls always names an element that exists. */}
              <pre
                id={panel}
                hidden={!shown}
                className="whitespace-pre-wrap break-words rounded-lg bg-asst-field px-2.5 py-2 font-plex-mono text-xs leading-5 text-asst-text"
              >
                {built.text}
              </pre>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
