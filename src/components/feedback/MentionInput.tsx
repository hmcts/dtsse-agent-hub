"use client";

import { type KeyboardEvent, type Ref, useId, useRef, useState } from "react";

/**
 * A comment box that offers people to `@` name as their name is typed. The hub matches a mention by the whole name
 * after the `@` (`mentionsIn`), so choosing someone writes their name out in full. Combobox semantics as the share
 * dialog's: `aria-expanded`, `aria-controls`, `aria-activedescendant`, a listbox of options, and up, down, Enter, Tab
 * and Escape.
 */

export interface MentionPerson {
  oid: string;
  name: string;
}

/** The `@` being typed at `caret`: where it starts and what follows it, or `undefined` when there is none. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1 || (at > 0 && /[\p{L}\p{N}]/u.test(before.charAt(at - 1)))) {
    return undefined;
  }
  const query = before.slice(at + 1);
  if (query.length > 60 || /[\n@]/.test(query) || query.startsWith(" ")) {
    return undefined;
  }
  return { start: at, query };
}

const MAX_SHOWN = 6;

/** The people whose name, or a word of it, starts with `query`, without regard to case. */
export function matchingPeople(people: readonly MentionPerson[], query: string): MentionPerson[] {
  const wanted = query.toLocaleLowerCase("en-GB");
  return people
    .filter((person) => {
      const name = person.name.toLocaleLowerCase("en-GB");
      return name.startsWith(wanted) || name.split(/\s+/).some((word) => word.startsWith(wanted));
    })
    .slice(0, MAX_SHOWN);
}

export function MentionInput({
  value,
  onChange,
  people,
  label,
  placeholder,
  disabled = false,
  rows = 3,
  autoFocus = false,
  onSubmit,
  inputRef
}: {
  value: string;
  onChange: (value: string) => void;
  people: readonly MentionPerson[];
  /** The box's accessible name. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  autoFocus?: boolean;
  /** Ctrl+Enter or Cmd+Enter. */
  onSubmit?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const ids = useId();
  const listId = `${ids}-people`;
  const local = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [current, setCurrent] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const typing = mentionQuery(value, caret);
  const shown = typing === undefined ? [] : matchingPeople(people, typing.query);
  const open = typing !== undefined && shown.length > 0 && dismissed !== typing.start;
  const highlighted = Math.min(current, Math.max(0, shown.length - 1));

  const setRefs = (element: HTMLTextAreaElement | null) => {
    local.current = element;
    if (typeof inputRef === "function") {
      inputRef(element);
    } else if (inputRef) {
      inputRef.current = element;
    }
  };

  const choose = (person: MentionPerson) => {
    if (typing === undefined) {
      return;
    }
    const inserted = `@${person.name} `;
    const next = `${value.slice(0, typing.start)}${inserted}${value.slice(caret)}`;
    const at = typing.start + inserted.length;
    onChange(next);
    setCaret(at);
    setCurrent(0);
    requestAnimationFrame(() => local.current?.setSelectionRange(at, at));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setCurrent((highlighted + step + shown.length) % shown.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const person = shown[highlighted];
        if (person !== undefined) {
          event.preventDefault();
          choose(person);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(typing?.start ?? null);
        return;
      }
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && onSubmit !== undefined) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={setRefs}
        value={value}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${highlighted}` : undefined}
        // biome-ignore lint/a11y/noAutofocus: the box is opened by the person asking to write a comment.
        autoFocus={autoFocus}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setCurrent(0);
          setDismissed(null);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        className="w-full resize-y rounded-lg border border-asst-strong bg-asst-field px-2.5 py-1.5 text-sm text-asst-text outline-hidden focus:border-asst-accent-line disabled:opacity-60"
      />
      <div
        id={listId}
        role="listbox"
        aria-label="People to mention"
        className={`${open ? "flex" : "hidden"} absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-56 flex-col overflow-y-auto rounded-xl border border-asst-strong bg-asst-raised p-1 shadow-2xl`}
      >
        {open
          ? shown.map((person, index) => (
              <div
                key={person.oid}
                id={`${listId}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === highlighted}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(person);
                }}
                className={`cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-sm ${index === highlighted ? "bg-asst-active" : ""}`}
              >
                {person.name}
              </div>
            ))
          : null}
      </div>
    </div>
  );
}
