import { readDmn } from "./dmn-model.ts";
import { listDir, readText } from "./file-io.ts";
import { parseFileName } from "./file-names.ts";
import { byCodePoint } from "./merge.ts";

/** The decision whose id is a task key, `wa-task-<kind>-<service>-<caseType>`, which is the file's main decision. */
export function keyedDecision<T extends { id: string }>(decisions: T[]): T | undefined {
  return decisions.find((d) => parseFileName(`${d.id}.dmn`) !== undefined);
}

/** Reads a DMN file, naming the file in any error. */
export function readDmnFile(name: string, xml: string): ReturnType<typeof readDmn> {
  try {
    return readDmn(xml);
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface TaskFile {
  name: string;
  /** The task key the file holds, from its main decision's id or else its name; none when it is not a task DMN. */
  key?: string;
  xml: string;
}

/** Every DMN in a directory with the task key it holds, found as an import finds them: by the main decision's id, else the file name. */
export function listTaskFiles(dir: string): TaskFile[] {
  return listDir(dir)
    .filter((name) => name.endsWith(".dmn"))
    .sort(byCodePoint)
    .map((name) => {
      const xml = readText(`${dir}/${name}`);
      const keyed = keyedDecision(readDmnFile(name, xml).document.decisions);
      const stem = name.replace(/\.dmn$/, "");
      return { name, xml, ...(keyed ? { key: keyed.id } : parseFileName(name) ? { key: stem } : {}) };
    });
}
