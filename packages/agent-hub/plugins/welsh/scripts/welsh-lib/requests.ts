/**
 * Requests sent to the Welsh Language Unit: the Ref that ties a request row
 * to its answer, and where request spreadsheets are written — the service's
 * requests/ folder by default, or a path the caller chooses (an HMCTS
 * Assistant pod writes to a scratch file and uploads it for download).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { cataloguePath } from "./catalogue.ts";
import { matchKey } from "./normalise.ts";
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

export function welshDir(service: string): string {
  return dirname(cataloguePath(service));
}

export function workDir(service: string, ...sub: string[]): string {
  const dir = join(welshDir(service), ".work", ...sub);
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
  const dir = join(welshDir(service), "requests");
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${batch}.xlsx`);
  for (let n = 2; existsSync(path); n++) {
    path = join(dir, `${batch}-${n}.xlsx`);
  }
  await writeRequest(path, rows, { batch, service, created });
  return path;
}
