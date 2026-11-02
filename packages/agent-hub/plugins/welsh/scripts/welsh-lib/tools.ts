/**
 * The programs the engine drives (git, gh, tar, twg, bash), each by its full path, looked up on PATH once per run.
 * PATH stays where they come from, since the engine runs wherever an engineer or a pod keeps its tools, but only its
 * absolute directories are searched: a relative entry such as `.` would let whatever directory the engine was started
 * in supply a program of the same name.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const found = new Map<string, string | null>();

/** The full path of a program on PATH, or null when there is none. */
export function findTool(name: string): string | null {
  const known = found.get(name);
  if (known !== undefined) {
    return known;
  }
  let path: string | null = null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) {
      continue;
    }
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) {
        path = file;
        break;
      }
    } catch {
      // Not here; try the next directory.
    }
  }
  found.set(name, path);
  return path;
}

/** The full path of a program the engine cannot do without, or an error that says which is missing. */
export function tool(name: string): string {
  const path = findTool(name);
  if (path === null) {
    throw new Error(`${name} is not installed, or not on PATH`);
  }
  return path;
}
