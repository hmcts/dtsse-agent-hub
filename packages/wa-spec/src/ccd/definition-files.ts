import { listEntries, readText } from "../file-io.ts";
import { byCodePoint } from "../merge.ts";

const SHEETS = new Set(["CaseType", "State", "CaseEvent"]);

/** The processor's exclusion patterns for each environment of a service that names its variants `-prod.json` and `-nonprod.json`, as ET does. */
export const ENVIRONMENT_EXCLUDES = { nonprod: ["*-prod.json"], prod: ["*-nonprod.json"] } as const;

/** The prefix of the environment variables the processor substitutes into every file as `${NAME}`. */
export const VARIABLE_PREFIX = "CCD_DEF";

/** The columns the reader takes from a row, which cannot be left as an unset `${NAME}` placeholder. */
const READ_COLUMNS = ["CaseTypeID", "ID", "PreConditionState(s)", "PostConditionState", "Publish"];

/** A processor exclusion pattern: `*` stands for any run of characters, and the whole name must match. */
const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replaceAll("*", ".*")}$`, "i");

/** The variables a process offers the processor: those of the environment that start with `CCD_DEF`. */
export const variablesFrom = (environment: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[0].startsWith(VARIABLE_PREFIX) && entry[1] !== undefined));

export interface ReadOptions {
  /** The processor's `-e` patterns; none exclude nothing. */
  exclude?: readonly string[];
  /** Values for `${NAME}` placeholders, replaced in every file's text before it is parsed, as the processor does. */
  variables?: Readonly<Record<string, string>>;
  /** Filled with the file and row of each row read, by sheet, for error messages. */
  sources?: Record<string, string[]>;
}

/** A definition file's rows, with the variables substituted, naming the file when it does not parse or leaves a read column unset. */
function parsed(file: string, variables: Readonly<Record<string, string>>): unknown[] {
  try {
    const text = Object.entries(variables).reduce((acc, [name, value]) => acc.replaceAll(`\${${name}}`, value), readText(file));
    const json: unknown = JSON.parse(text);
    const rows = Array.isArray(json) ? json : [json];
    for (const row of rows) {
      for (const column of READ_COLUMNS) {
        const value = typeof row === "object" && row !== null ? (row as Record<string, unknown>)[column] : undefined;
        const unset = typeof value === "string" ? /\$\{([^}]+)\}/.exec(value) : null;
        if (unset) {
          throw new Error(`${column} is \${${unset[1]}}, which is not set: pass --var ${unset[1]}=<value> or set it in the environment`);
        }
      }
    }
    return rows;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads the sheets a lifecycle needs from a definition directory the way ccd-definition-processor's `json2xlsx -D <dir>` reads
 * them: every `.json` file below the directory belongs to the sheet named by the first folder of its path, or by its own name
 * for a file directly in the directory, and a sheet's files are concatenated, a file holding one object being one row. A file
 * is left out when any segment of its path matches one of the exclusion patterns (`-e` of the processor, matched per segment).
 * `${NAME}` placeholders are replaced from `variables` first, as the processor's Substitutor does. Symlinks are not followed.
 * `dir` must be the definition root, the processor's `-D`.
 */
export function readDefinitionDir(dir: string, options: ReadOptions = {}): Record<string, unknown[]> {
  const excluded = (options.exclude ?? []).map(globToRegExp);
  const sheets: Record<string, unknown[]> = {};
  const walk = (path: string, segments: string[]): void => {
    for (const { name, kind } of listEntries(path).sort((a, b) => byCodePoint(a.name, b.name))) {
      const below = [...segments, name];
      if (excluded.some((pattern) => below.some((segment) => pattern.test(segment)))) {
        continue;
      }
      if (kind === "dir") {
        walk(`${path}/${name}`, below);
      } else if (kind === "file" && name.endsWith(".json")) {
        const sheet = (below[0] as string).replace(/\.json$/, "");
        if (SHEETS.has(sheet)) {
          const rows = parsed(`${path}/${name}`, options.variables ?? {});
          sheets[sheet] = [...(sheets[sheet] ?? []), ...rows];
          if (options.sources) {
            options.sources[sheet] = [...(options.sources[sheet] ?? []), ...rows.map((_, index) => `${path}/${name} row ${index + 1}`)];
          }
        }
      }
    }
  };
  walk(dir, []);
  return sheets;
}
