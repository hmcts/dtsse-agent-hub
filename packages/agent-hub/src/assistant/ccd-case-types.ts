// The pod's half of the Bulk Scan builder's two CCD jobs: the workspace's `scripts/ccd-case-types` run in the owner's own
// clone, which is the only place the case types' definitions are. `list` names the case types the workspace knows and
// `fields` reads one's case fields; for a config-generator service the script generates the definition with Gradle first,
// which takes up to about 35 seconds. Fixed: the only program run is that script, and each value in the job is checked
// again here and passed as its own argument. See "CCD case types" in dtsse-agent-hub's docs/agent-api.md.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../env.ts";
import type { Run } from "./lookups.ts";
import { type PodJobContext, PodJobError } from "./pod-jobs.ts";

export const LIST_TIMEOUT_MS = 40_000;
/** Past the longest Gradle generation seen cold, inside the hub's 180 seconds for the job. */
export const FIELDS_TIMEOUT_MS = 160_000;
/** What an answer's fields may hold in JSON bytes: the hub takes 1 MiB, and the form's upload that carries them takes the same. */
export const MAX_FIELDS_BYTES = 900_000;
const MAX_FIELDS = 20_000;
const MAX_CASE_TYPES = 500;

const CASE_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const PRODUCT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const CONFIGS = new Set(["config-generator", "json", "hybrid"]);

export const SCRIPT_MISSING =
  "Your workspace has no CCD case type tool yet. Update your workspace (the cft-workspace checkout in your assistant), then try again.";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  return Array.from(value).slice(0, max).join("");
};

export type FieldRow = { ID: string; Label?: string; FieldType: string; FieldTypeParameter?: string; HintText?: string };

const bytesOf = (row: FieldRow): number => Buffer.byteLength(JSON.stringify(row), "utf8") + 1;

/**
 * The script's rows cut down to what matching needs: label rows go (nothing maps to one), absent values go, and long
 * text is clipped to the hub's limits. When that is still over `maxBytes`, the `Parent.Child` members go, and then rows
 * from the end, and `omitted` says how many were left out for size.
 */
export function fitFields(rows: unknown[], maxBytes: number = MAX_FIELDS_BYTES): { fields: FieldRow[]; total: number; omitted: number } {
  const slim = rows.flatMap((raw): FieldRow[] => {
    const row = asRecord(raw);
    const id = text(row?.ID, 300);
    const type = text(row?.FieldType, 60);
    if (!row || !id || !type || type === "Label") {
      return [];
    }
    const label = text(row.Label, 200);
    const parameter = text(row.FieldTypeParameter, 100);
    const hint = text(row.HintText, 200);
    return [
      {
        ID: id,
        ...(label ? { Label: label } : {}),
        FieldType: type,
        ...(parameter ? { FieldTypeParameter: parameter } : {}),
        ...(hint ? { HintText: hint } : {})
      }
    ];
  });
  const size = (list: FieldRow[]): number => list.reduce((n, row) => n + bytesOf(row), 2);
  let kept = slim;
  if (size(kept) > maxBytes || kept.length > MAX_FIELDS) {
    kept = kept.filter((row) => !row.ID.includes("."));
  }
  let used = 2;
  const fits: FieldRow[] = [];
  for (const row of kept) {
    used += bytesOf(row);
    if (used > maxBytes || fits.length >= MAX_FIELDS) {
      break;
    }
    fits.push(row);
  }
  return { fields: fits, total: rows.length, omitted: slim.length - fits.length };
}

/** Why the script failed, as the hub's code and words for the person. */
export function scriptFailure(stderr: string, code: number): PodJobError {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const message = lines.at(-1) ?? "";
  const detail = Array.from(message).slice(0, 280).join("") || "That did not work. Try again.";
  if (code === 127) {
    return new PodJobError("script_missing", SCRIPT_MISSING);
  }
  if (/unknown case type/i.test(stderr)) {
    return new PodJobError("unknown_case_type", detail);
  }
  if (/defined by more than one product/i.test(stderr)) {
    return new PodJobError("ambiguous_case_type", detail);
  }
  if (/is not cloned/i.test(stderr)) {
    return new PodJobError("not_cloned", detail);
  }
  if (/generateCCDConfig|no current build\/definitions/i.test(stderr)) {
    return new PodJobError("generation_failed", detail);
  }
  return new PodJobError("failed", detail);
}

export type CcdDeps = { run: Run; workspace?: string; exists?: (path: string) => boolean };

function workspaceOf(env: Env, deps: CcdDeps): string {
  return deps.workspace ?? env.VIRTUAL_AGENT_WORKSPACE ?? "/workspace/cft-workspace";
}

async function script(context: PodJobContext, deps: CcdDeps, args: string[], timeoutMs: number): Promise<unknown> {
  const workspace = workspaceOf(context.env, deps);
  const path = join(workspace, "scripts", "ccd-case-types");
  if (!(deps.exists ?? existsSync)(path)) {
    throw new PodJobError("script_missing", SCRIPT_MISSING);
  }
  const result = await deps.run(path, args, { env: context.env, timeoutMs, signal: context.signal });
  if (result.code !== 0) {
    throw scriptFailure(result.stderr, result.code);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new PodJobError("unreadable", "The CCD case type tool answered something that is not JSON. Update your workspace, then try again.");
  }
}

/** `ccd.case-types`: every case type the workspace's products declare. */
export async function listCaseTypes(args: unknown, context: PodJobContext, deps: CcdDeps): Promise<{ case_types: object[] }> {
  if (Object.keys(asRecord(args) ?? { x: 1 }).length > 0) {
    throw new Error("the job's arguments are not ones this client can run");
  }
  const rows = await script(context, deps, ["list"], LIST_TIMEOUT_MS);
  if (!Array.isArray(rows)) {
    throw new PodJobError("unreadable", "The CCD case type tool did not answer a list. Update your workspace, then try again.");
  }
  const found = rows.flatMap((raw) => {
    const row = asRecord(raw);
    const caseType = text(row?.caseType, 100);
    const product = text(row?.product, 40);
    if (!row || !caseType || !product || !CASE_TYPE_RE.test(caseType) || !PRODUCT_RE.test(product)) {
      return [];
    }
    const config = typeof row.ccdConfig === "string" && CONFIGS.has(row.ccdConfig) ? row.ccdConfig : null;
    return [{ product, service: text(row.service, 100) ?? product, case_type: caseType, config }];
  });
  return { case_types: found.slice(0, MAX_CASE_TYPES) };
}

/** `ccd.case-type-fields`: one case type's fields, cut down to fit the answer. */
export async function caseTypeFields(args: unknown, context: PodJobContext, deps: CcdDeps): Promise<{ fields: FieldRow[]; total: number; omitted: number }> {
  const raw = asRecord(args);
  const caseType = raw?.case_type;
  const product = raw?.product;
  if (
    !raw ||
    Object.keys(raw).some((k) => k !== "case_type" && k !== "product") ||
    typeof caseType !== "string" ||
    !CASE_TYPE_RE.test(caseType) ||
    (product !== undefined && !(typeof product === "string" && PRODUCT_RE.test(product)))
  ) {
    throw new Error("the job's arguments are not ones this client can run");
  }
  const rows = await script(context, deps, ["fields", caseType, ...(typeof product === "string" ? ["--product", product] : [])], FIELDS_TIMEOUT_MS);
  if (!Array.isArray(rows)) {
    throw new PodJobError("unreadable", "The CCD case type tool did not answer a list of fields. Update your workspace, then try again.");
  }
  return fitFields(rows);
}
