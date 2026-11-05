"use client";

import { createContext, useContext, useState } from "react";
import type { ExportDefaults } from "@/assistant/export-defaults";
import type { Theme } from "@/assistant/theme";

/**
 * The settings the dialog saves with its one Save, by the key each is held under while it is being edited. Anything
 * not here — a connect, a pasted token, a template, a file, a restart, a reset to the default — is an action, and its
 * own button does it at once.
 */
export interface SettingsValues {
  theme: Theme;
  model: string;
  size: string;
  plugins: string[];
  claudeMd: string;
  git: { name: string; email: string };
  exports: ExportDefaults;
}

export type DraftKey = keyof SettingsValues;

/** Some of the settings, each under its own key. */
export type Values = { [K in DraftKey]?: SettingsValues[K] };

export type DraftErrors = Partial<Record<DraftKey, string>>;

/**
 * What a section is given of the dialog's drafts. `saved` is what this dialog has itself stored, by a Save or by an
 * action such as a reset to the default: the page's own values catch up only once its refresh lands, and some never
 * reach it — the appearance is the browser's cookie — so until then a section measures a change against these.
 */
export interface SettingsDraftsContext {
  /** The person's changes that are still to be saved. */
  drafts: Values;
  saved: Values;
  errors: DraftErrors;
  /** `stored` is whether `value` is what is saved already, which the section knows and the dialog does not. */
  change: <K extends DraftKey>(key: K, value: SettingsValues[K], stored: boolean) => void;
  /** A value one of the section's own actions has just saved, such as a reset to the default. */
  settle: <K extends DraftKey>(key: K, value: SettingsValues[K]) => void;
  /** How many saves have succeeded, so a section that reads its own data can read it again after one. */
  saves: number;
}

export const SettingsDrafts = createContext<SettingsDraftsContext | null>(null);

function without<T extends object>(values: T, keys: readonly PropertyKey[]): T {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key))) as T;
}

export interface DraftStore extends SettingsDraftsContext {
  /**
   * What a Save did: `stored` the keys whose values in `sent` are now saved, and `refused` why each other key was
   * not. A draft changed again while the save was in flight is the person's still to save.
   */
  commit: (sent: Values, stored: readonly DraftKey[], refused: readonly (readonly [DraftKey, string])[]) => void;
  /** Throws the unsaved changes away, and what their last save was refused with. */
  discard: () => void;
  /** Forgets everything, for a dialog that has closed: the next one starts from the page. */
  reset: () => void;
}

/**
 * The drafts, held above the dialog rather than in it or in a section: only the open section is rendered, and the
 * dialog itself is remounted when an address names another section while it is open, so a draft held any lower would
 * be lost without the person being asked.
 */
export function useDraftStore(): DraftStore {
  const [drafts, setDrafts] = useState<Values>({});
  const [saved, setSaved] = useState<Values>({});
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saves, setSaves] = useState(0);
  return {
    drafts,
    saved,
    errors,
    saves,
    change: (key, value, stored) => {
      setDrafts((last) => (stored ? without(last, [key]) : { ...last, [key]: value }));
      setErrors((last) => without(last, [key]));
    },
    settle: (key, value) => {
      setSaved((last) => ({ ...last, [key]: value }));
      setDrafts((last) => without(last, [key]));
      setErrors((last) => without(last, [key]));
    },
    commit: (sent, stored, refused) => {
      setSaved((last) => ({ ...last, ...Object.fromEntries(stored.map((key) => [key, sent[key]])) }));
      setDrafts((last) =>
        without(
          last,
          stored.filter((key) => last[key] === sent[key])
        )
      );
      setErrors(Object.fromEntries(refused));
      if (stored.length > 0) {
        setSaves((count) => count + 1);
      }
    },
    discard: () => {
      setDrafts({});
      setErrors({});
    },
    reset: () => {
      setDrafts({});
      setSaved({});
      setErrors({});
    }
  };
}

function useDrafts(): SettingsDraftsContext {
  const context = useContext(SettingsDrafts);
  if (context === null) {
    throw new Error("a settings section is rendered outside the settings dialog");
  }
  return context;
}

/** How many of the dialog's saves have succeeded, for a section that reads its own data to read it again after one. */
export function useSettingsSaves(): number {
  return useDrafts().saves;
}

/**
 * One setting of a section: what to show, which is the person's draft once they have changed it and otherwise what is
 * stored; a way to change it; and the error its last save was refused with.
 *
 * What is stored is what this dialog last saved, where it has saved one, and the page's value otherwise. `same` says
 * whether a value is the stored one, so going back to it leaves nothing to save.
 */
export function useSettingsDraft<K extends DraftKey>(
  key: K,
  stored: SettingsValues[K],
  same: (a: SettingsValues[K], b: SettingsValues[K]) => boolean = (a, b) => a === b
): {
  value: SettingsValues[K];
  /** Whether `value` is what is stored, so a section can say there is nothing to save. */
  unchanged: boolean;
  set: (value: SettingsValues[K]) => void;
  settle: (value: SettingsValues[K]) => void;
  error: string | null;
} {
  const context = useDrafts();
  const baseline = (context.saved[key] as SettingsValues[K] | undefined) ?? stored;
  const draft = context.drafts[key] as SettingsValues[K] | undefined;
  return {
    value: draft ?? baseline,
    unchanged: draft === undefined,
    set: (value) => context.change(key, value, same(value, baseline)),
    settle: (value) => context.settle(key, value),
    error: context.errors[key] ?? null
  };
}
