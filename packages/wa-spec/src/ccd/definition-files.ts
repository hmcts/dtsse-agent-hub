import { exists, isDirectory, listDir, readText } from "../file-io.ts";
import { byCodePoint } from "../merge.ts";

const SHEETS = new Set(["CaseType", "State", "CaseEvent"]);

/** `CaseEvent-WA.json` and `CaseEvent/CaseEvent-WA.json` are both rows of the sheet `CaseEvent`. */
const sheetOf = (fileName: string): string => fileName.replace(/\.json$/, "").split("-")[0] ?? "";

/**
 * Reads the sheets a lifecycle needs from a definition directory, whether it is one directory per sheet holding one or more
 * files (ET's `definitions/json`) or the files side by side or per case type (what ccd-config-generator writes). Given a service repo's root it reads `definitions/json`, so the test fixtures a repo keeps elsewhere are not mistaken for sheets. A service that
 * keeps a `-prod` and a `-nonprod` file for the same sheet has one environment's files read.
 */
export function readDefinitionDir(dir: string, environment: "prod" | "nonprod" = "nonprod"): Record<string, unknown[]> {
  const other = environment === "prod" ? "-nonprod.json" : "-prod.json";
  const sheets: Record<string, unknown[]> = {};
  const walk = (path: string): void => {
    for (const name of listDir(path).sort(byCodePoint)) {
      const child = `${path}/${name}`;
      if (isDirectory(child)) {
        walk(child);
      } else if (name.endsWith(".json") && !name.endsWith(other) && SHEETS.has(sheetOf(name))) {
        const rows: unknown = JSON.parse(readText(child));
        sheets[sheetOf(name)] = [...(sheets[sheetOf(name)] ?? []), ...(Array.isArray(rows) ? rows : [])];
      }
    }
  };
  walk(exists(`${dir}/definitions/json`) ? `${dir}/definitions/json` : dir);
  return sheets;
}
