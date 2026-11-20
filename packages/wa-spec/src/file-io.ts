import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/*
 * Every file the tools read or write, whether named on the command line or found under a directory named there. They are an
 * operator's own paths, so none of these is a path traversal.
 */

export const readText = (path: string): string => readFileSync(path, "utf8"); // NOSONAR: a path the operator passed

export const listDir = (dir: string): string[] => readdirSync(dir); // NOSONAR: a directory the operator passed

export const isDirectory = (path: string): boolean => statSync(path).isDirectory(); // NOSONAR: a path the operator passed

export const exists = (path: string): boolean => existsSync(path); // NOSONAR: a path the operator passed

/** Writes the file, creating the directories above it. */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true }); // NOSONAR: a path the operator passed
  writeFileSync(path, text); // NOSONAR: a path the operator passed
}
