/**
 * Interpolation tokens must come through translation unchanged — a dropped
 * `{{name}}` prints nothing, a translated one prints the raw token. Every
 * syntax seen across the services is checked, whichever format the string
 * is headed for.
 */

const TOKEN = /\{\{[^{}]+\}\}|\$\{[^{}]+\}|%\{[^{}]+\}|\(\([^()]+\)\)|%[A-Z][A-Z0-9_]*%|\{\d+\}|\{[A-Za-z_][\w.]*\}|%[sd]/g;

export function tokens(text: string): string[] {
  return (text.match(TOKEN) ?? []).map((t) => t.replace(/\s+/g, "")).sort();
}

/** Problems with the Welsh's tokens, or [] when they match the English exactly. */
export function tokenProblems(english: string, welsh: string): string[] {
  const en = tokens(english);
  const cy = tokens(welsh);
  const problems: string[] = [];
  const missing = difference(en, cy);
  const extra = difference(cy, en);
  if (missing.length) {
    problems.push(`missing ${missing.join(", ")}`);
  }
  if (extra.length) {
    problems.push(`unexpected ${extra.join(", ")}`);
  }
  return problems;
}

/** Multiset a − b. */
function difference(a: string[], b: string[]): string[] {
  const left = [...b];
  return a.filter((t) => {
    const i = left.indexOf(t);
    if (i < 0) {
      return true;
    }
    left.splice(i, 1);
    return false;
  });
}
