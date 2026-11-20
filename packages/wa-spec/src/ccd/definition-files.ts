import { listEntries, readText } from "../file-io.ts";
import { byCodePoint } from "../merge.ts";

const SHEETS = new Set(["CaseType", "State", "CaseEvent"]);

/** The processor's exclusion patterns for each environment of a service that names its variants `-prod.json` and `-nonprod.json`, as ET does. */
export const ENVIRONMENT_EXCLUDES = { nonprod: ["*-prod.json"], prod: ["*-nonprod.json"] } as const;

/** A processor exclusion pattern: `*` stands for any run of characters, and the whole name must match. */
const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replaceAll("*", ".*")}$`, "i");

/**
 * Reads the sheets a lifecycle needs from a definition directory the way ccd-definition-processor's `json2xlsx -D <dir>` reads
 * them: every `.json` file below the directory belongs to the sheet named by the first folder of its path, or by its own name
 * for a file directly in the directory, and a sheet's files are concatenated, a file holding one object being one row. A file is left out when any segment of its path
 * matches one of the exclusion patterns (`-e` of the processor, matched per segment). Symlinks are not followed.
 * `dir` must be the definition root, the processor's `-D`.
 */
export function readDefinitionDir(dir: string, exclude: readonly string[] = ENVIRONMENT_EXCLUDES.nonprod): Record<string, unknown[]> {
  const excluded = exclude.map(globToRegExp);
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
          const rows: unknown = JSON.parse(readText(`${path}/${name}`));
          sheets[sheet] = [...(sheets[sheet] ?? []), ...(Array.isArray(rows) ? rows : [rows])];
        }
      }
    }
  };
  walk(dir, []);
  return sheets;
}
