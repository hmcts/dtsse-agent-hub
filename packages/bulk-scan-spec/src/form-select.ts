import type { Bundle, FormSpec } from "./schema.ts";

/** The forms a `--form n` option names (1-based), or all of them when it is absent. */
export function selectForms(bundle: Bundle, option: string | undefined): FormSpec[] {
  if (option === undefined) {
    return bundle.forms;
  }
  const n = Number(option);
  if (option.trim() === "" || !Number.isInteger(n) || n < 1 || n > bundle.forms.length) {
    throw new Error(`--form must be a whole number from 1 to ${bundle.forms.length}, not ${JSON.stringify(option)}`);
  }
  const form = bundle.forms[n - 1];
  return form ? [form] : [];
}

/** The single form a one-form output needs: the bundle's only form, or the one `--form` names. */
export function requireOneForm(bundle: Bundle, option: string | undefined): FormSpec {
  if (option === undefined && bundle.forms.length > 1) {
    throw new Error(`the bundle has ${bundle.forms.length} forms: pass --form <n> to say which one`);
  }
  const [form] = selectForms(bundle, option);
  if (!form) {
    throw new Error("the bundle has no forms");
  }
  return form;
}
