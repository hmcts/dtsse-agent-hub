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
  /** The file as read. */
  read: ReturnType<typeof readDmn>;
}

/**
 * Every DMN in a directory with the task key it holds, found as an import finds them: by the main decision's id, else the file
 * name. Names in `skip` are not read.
 */
export function listTaskFiles(dir: string, skip: ReadonlySet<string> = new Set()): TaskFile[] {
  return listDir(dir)
    .filter((name) => name.endsWith(".dmn") && !skip.has(name))
    .sort(byCodePoint)
    .map((name) => {
      const read = readDmnFile(name, readText(`${dir}/${name}`));
      const keyed = keyedDecision(read.document.decisions);
      return { name, read, ...(keyed ? { key: keyed.id } : parseFileName(name) ? { key: name.replace(/\.dmn$/, "") } : {}) };
    });
}
