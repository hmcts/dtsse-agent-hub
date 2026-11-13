"use client";

import { useEffect, useId, useState } from "react";
import { MIN_PEOPLE_QUERY } from "@/access/rules";
import { useSuggestions } from "@/components/useSuggestions";
import type { ActionResult } from "@/web/action";
import { ACTION_UNREACHABLE } from "@/web/action-fault";
import { FIELD, SECONDARY } from "./look";

/** The interactive pieces the team's feedback pages share: the page's origin, actions, copying and the people picker. */

/**
 * The page's own origin, once there is a browser to ask: the server renders the bare path, and a first render that
 * disagreed with it would be a hydration mismatch.
 */
export function useOrigin(given?: string): string {
  const [origin, setOrigin] = useState(given ?? "");
  useEffect(() => {
    if (given === undefined) {
      setOrigin(window.location.origin);
    }
  }, [given]);
  return origin;
}

/** Calls a server action, turning a rejection (the network, not a refusal) into the sentence every action uses. */
export async function call<T extends object>(action: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await action();
  } catch {
    return { ok: false, error: ACTION_UNREACHABLE };
  }
}

/** A read-only address with a Copy button, falling back to selecting it where the clipboard is refused. */
export function CopyField({ label, value, openLabel }: Readonly<{ label: string; value: string; openLabel?: string }>) {
  const id = useId();
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      const field = document.getElementById(id);
      if (field instanceof HTMLInputElement) {
        field.select();
      }
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-asst-faint">
        {label}
      </label>
      <div className="flex flex-wrap gap-2">
        <input id={id} readOnly value={value} className={`${FIELD} min-w-0 flex-1 text-xs text-asst-muted`} />
        <button type="button" onClick={() => void copy()} aria-label={`${copied ? "Copied" : "Copy"} ${label}`} className={SECONDARY}>
          {copied ? "Copied" : "Copy"}
        </button>
        {openLabel === undefined ? null : (
          <a href={value} target="_blank" rel="noopener" aria-label={`${openLabel} ${label} (opens in a new tab)`} className={SECONDARY}>
            {openLabel}
          </a>
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {copied ? "Copied to the clipboard" : ""}
      </p>
    </div>
  );
}

export interface PickedPerson {
  oid: string;
  name: string;
  email: string | null;
}

/**
 * Names people from everyone who has used the hub, as the share dialog does: the same suggestions over
 * `/api/ui/people` and the same combobox keys. Chosen people are held by the caller, which saves them when it is
 * ready rather than one at a time.
 */
export function PeoplePicker({
  label,
  people,
  onChange,
  exclude = [],
  disabled = false
}: Readonly<{
  label: string;
  people: readonly PickedPerson[];
  onChange: (people: PickedPerson[]) => void;
  /** People who may not be chosen, such as the project's owner. */
  exclude?: readonly string[];
  disabled?: boolean;
}>) {
  const ids = useId();
  const listId = `${ids}-people`;
  const suggestions = useSuggestions<PickedPerson>({
    path: "/api/ui/people",
    field: "people",
    minQuery: MIN_PEOPLE_QUERY,
    exclude: (candidate) => exclude.includes(candidate.oid) || people.some((person) => person.oid === candidate.oid),
    onChoose: (candidate) => {
      onChange([...people, candidate]);
      suggestions.clear();
    }
  });
  const { shown, open, current } = suggestions;
  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${ids}-who`} className="text-xs text-asst-faint">
        {label}
      </label>
      <div className="relative">
        <input
          id={`${ids}-who`}
          value={suggestions.query}
          disabled={disabled}
          autoComplete="off"
          placeholder="Start typing a name"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? optionId(current) : undefined}
          onChange={(event) => suggestions.setQuery(event.target.value)}
          onKeyDown={suggestions.onKeyDown}
          className={`${FIELD} w-full text-sm`}
        />
        <div
          id={listId}
          role="listbox"
          aria-label="People"
          hidden={!open}
          className={`${open ? "flex" : "hidden"} absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-56 flex-col overflow-y-auto rounded-xl border border-asst-strong bg-asst-raised p-1 shadow-2xl`}
        >
          {open
            ? shown.map((candidate, index) => (
                <div
                  key={candidate.oid}
                  id={optionId(index)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === current}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => suggestions.choose(candidate)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      suggestions.choose(candidate);
                    }
                  }}
                  className={`flex cursor-pointer flex-col rounded-lg px-2.5 py-1.5 text-left text-sm ${index === current ? "bg-asst-active" : ""}`}
                >
                  <span>{candidate.name}</span>
                  {candidate.email === null ? null : <span className="text-xs text-asst-faint">{candidate.email}</span>}
                </div>
              ))
            : null}
        </div>
      </div>
      <p className="text-xs text-asst-faint">Only people who have used the hub can be named.</p>
      {people.length === 0 ? null : (
        <ul aria-label={label} className="flex flex-col gap-1">
          {people.map((person) => (
            <li key={person.oid} className="flex items-center gap-2 rounded-lg border border-asst-line px-2.5 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {person.name}
                {person.email === null ? null : <span className="ml-2 text-xs text-asst-faint">{person.email}</span>}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(people.filter((other) => other.oid !== person.oid))}
                className="shrink-0 rounded-md px-1.5 text-xs text-asst-error hover:bg-asst-field"
              >
                <span aria-hidden="true">Remove</span>
                <span className="sr-only">{`Remove ${person.name}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
