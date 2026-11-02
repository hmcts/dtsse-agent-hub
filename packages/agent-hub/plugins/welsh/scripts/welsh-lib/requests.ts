/**
 * Requests sent to the Welsh Language Unit: the Ref that ties a request row
 * to its answer, and where request spreadsheets are written — the service's
 * working folder in the workspace by default, or a path the caller chooses (a
 * CFT Workspace pod writes to a scratch file and uploads it for download).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { matchKey } from "./normalise.ts";
import { workspace } from "./paths.ts";
import { type RequestRow, writeRequest } from "./xlsx.ts";

/**
 * Stable per service + English. The same string gets the same Ref whether it came
 * from a story or a scan, so a WLU return lines up with every place it is used.
 */
export function contentRef(service: string, english: string): string {
  return `CY-${createHash("sha1")
    .update(`${service}\u0000${matchKey(english)}`)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase()}`;
}

/**
 * Scan results, story previews and request spreadsheets: the person's own working files, in the workspace beside the
 * service's other scaffolding and ignored there, since the catalogue itself is in the service's home repo.
 */
export function workDir(service: string, ...sub: string[]): string {
  const dir = join(workspace(), "apps", service, ".welsh-work", ...sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function saveRequest(service: string, label: string, rows: RequestRow[], out?: string): Promise<string> {
  const created = new Date().toISOString().slice(0, 10);
  const batch = `${created}-${label}`.replace(/[^A-Za-z0-9._-]+/g, "-");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    await writeRequest(out, rows, { batch, service, created });
    return out;
  }
  const dir = workDir(service, "requests");
  let path = join(dir, `${batch}.xlsx`);
  for (let n = 2; existsSync(path); n++) {
    path = join(dir, `${batch}-${n}.xlsx`);
  }
  await writeRequest(path, rows, { batch, service, created });
  return path;
}
