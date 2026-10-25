"use client";

import { type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { matchSkills, pickSkill, type Skill, skillQuery } from "@/agents/skills";

/**
 * The one "/" autocomplete over a session's skills, shared by the hub's direct-message box and the Assistant's
 * composer. The combobox semantics live here because they are what the two surfaces have to agree on and what a
 * second copy would drift from: the `aria-expanded`/`aria-controls`/`aria-activedescendant` trio on the box, the
 * `listbox` and `option` roles, and the keys that move, pick and dismiss. A `SkillMenuTheme` carries only what they
 * are each free to differ on — their own tokens, type scale and where the list sits.
 *
 * The matching itself is `src/agents/skills.ts`, which is pure and is where the server reads the same shapes from.
 */

export interface SkillMenuTheme {
  /** The listbox, including where it sits relative to the box: each composer stacks its own popovers differently. */
  list: string;
  /** Every option, whichever is current. */
  option: string;
  /** The option the keyboard is on, and the rest. */
  active: string;
  idle: string;
  /** The skill's `/name`. */
  name: string;
  /** A description's own classes, which differ with the option's state because what it must contrast with does. */
  description: (active: boolean) => string;
}

export interface SkillMenu {
  /** Spread on the box: the combobox semantics, and nothing at all when there are no skills to offer. */
  fieldProps: Record<string, unknown>;
  /** The listbox, or `null` when there are no skills to offer. */
  list: React.ReactNode;
  /** Whether the key was the menu's, so the composer must not also act on it. */
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Replaces the composer's own change handler, so a reopened list follows what is now typed. */
  onChange: (value: string) => void;
  /** Call on change and on select, so the list closes when the caret leaves the leading token. */
  track: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void;
}

/**
 * The menu attached to one text box. It opens while the caret is in a "/" token that starts the message, and Escape
 * keeps it shut until the message changes. `field` is the composer's own ref rather than one made here: a composer
 * has its own uses for the box — focusing it after a send, measuring it to grow — and one element takes one ref.
 */
export function useSkillMenu({
  skills,
  body,
  setBody,
  field,
  theme
}: {
  skills: readonly Skill[];
  body: string;
  setBody: (body: string) => void;
  field: RefObject<HTMLTextAreaElement | null>;
  theme: SkillMenuTheme;
}): SkillMenu {
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [lastQuery, setLastQuery] = useState<string | null>(null);
  const placeCaret = useRef<number | null>(null);

  const query = skills.length === 0 ? null : skillQuery(body, caret);
  if (query !== lastQuery) {
    setLastQuery(query);
    setActive(0);
  }
  const matches = query === null ? [] : matchSkills(skills, query);
  const open = !dismissed && matches.length > 0;
  const current = open ? Math.min(active, matches.length - 1) : -1;
  const optionId = (index: number) => `${listId}-${index}`;

  useLayoutEffect(() => {
    if (placeCaret.current !== null && field.current !== null) {
      field.current.setSelectionRange(placeCaret.current, placeCaret.current);
      placeCaret.current = null;
    }
  });

  function pick(skill: Skill): void {
    const picked = pickSkill(body, skill.name);
    placeCaret.current = picked.caret;
    setCaret(picked.caret);
    setBody(picked.body);
    field.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open) {
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
      setActive((current + step) % matches.length);
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) || event.key === "Tab") {
      event.preventDefault();
      const chosen = matches[current];
      if (chosen !== undefined) {
        pick(chosen);
      }
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    return false;
  }

  function track(event: React.SyntheticEvent<HTMLTextAreaElement>): void {
    setCaret(event.currentTarget.selectionStart);
  }

  function onChange(value: string): void {
    setDismissed(false);
    setBody(value);
  }

  const fieldProps =
    skills.length === 0
      ? {}
      : {
          role: "combobox",
          "aria-autocomplete": "list" as const,
          "aria-expanded": open,
          "aria-controls": listId,
          "aria-activedescendant": open ? optionId(current) : undefined
        };

  const list = (
    <div id={listId} role="listbox" aria-label="Skills" hidden={!open} className={theme.list}>
      {open
        ? matches.map((skill, index) => (
            <div
              key={skill.name}
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === current}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(skill)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  pick(skill);
                }
              }}
              className={`${theme.option} ${index === current ? theme.active : theme.idle}`}
            >
              <span className={theme.name}>/{skill.name}</span>
              {skill.description ? <span className={theme.description(index === current)}>{skill.description}</span> : null}
            </div>
          ))
        : null}
    </div>
  );

  return { fieldProps, list: skills.length === 0 ? null : list, onKeyDown, onChange, track };
}
