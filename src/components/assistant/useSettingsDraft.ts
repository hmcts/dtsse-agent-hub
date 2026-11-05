"use client";

import { createContext, useContext } from "react";
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

/** One setting as the dialog holds it: the value the person has given it, and whether that is still to be saved. */
export interface Draft<K extends DraftKey> {
  value: SettingsValues[K];
  dirty: boolean;
}

export type Drafts = { [K in DraftKey]?: Draft<K> };

/** What a section is given of the dialog's drafts. */
export interface SettingsDraftsContext {
  drafts: Drafts;
  errors: Partial<Record<DraftKey, string>>;
  /** `stored` is whether `value` is what is saved already, which the section knows and the dialog does not. */
  change: <K extends DraftKey>(key: K, value: SettingsValues[K], stored: boolean) => void;
  /** A value one of the section's own actions has just saved, such as a reset to the default. */
  settle: <K extends DraftKey>(key: K, value: SettingsValues[K]) => void;
  /** How many saves have succeeded, so a section that reads its own data can read it again after one. */
  saves: number;
}

export const SettingsDrafts = createContext<SettingsDraftsContext | null>(null);

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
 * One setting of a section: what to show, which is the person's draft once they have changed it and what is stored
 * until then; a way to change it; and the error its last save was refused with.
 *
 * Held by the dialog rather than the section, because only the open section is rendered: a draft kept in the section
 * would be lost as the person moved to another before saving. `same` says whether a value is the stored one, so going
 * back to it leaves nothing to save.
 */
export function useSettingsDraft<K extends DraftKey>(
  key: K,
  stored: SettingsValues[K],
  same: (a: SettingsValues[K], b: SettingsValues[K]) => boolean = (a, b) => a === b
): {
  value: SettingsValues[K];
  set: (value: SettingsValues[K]) => void;
  settle: (value: SettingsValues[K]) => void;
  error: string | null;
} {
  const context = useDrafts();
  const draft = context.drafts[key] as Draft<K> | undefined;
  return {
    value: draft === undefined ? stored : draft.value,
    set: (value) => context.change(key, value, same(value, stored)),
    settle: (value) => context.settle(key, value),
    error: context.errors[key] ?? null
  };
}
