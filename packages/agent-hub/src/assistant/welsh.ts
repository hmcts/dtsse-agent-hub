// The supervisor's half of a Welsh translation job for the HMCTS Assistant's Welsh page: one run of cft-workspace's
// `scripts/welsh`, as the owner, with their own GitHub and twg sign-ins. Fixed: every value in the frame is checked
// again here and passed as its own argument, never through a shell, and the only program run is that script. No job
// goes through a model, and none generates Welsh — the script takes it from the catalogue or a Welsh Language Unit
// return and refuses anything else. See "Welsh translation jobs" in dtsse-agent-hub's docs/agent-api.md.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, WelshAnswer } from "../api.ts";
import type { Env } from "../env.ts";
import { withRetry } from "../retry.ts";
import type { Run } from "./lookups.ts";

export const WELSH_KINDS = [
  "info",
  "search",
  "scan",
  "import_check",
  "import",
  "apply_preview",
  "apply",
  "story_candidates",
  "story_preview",
  "story_write"
] as const;
export type WelshKind = (typeof WELSH_KINDS)[number];

/** Run beside everything else, because somebody is waiting on the page for them. */
const QUICK: readonly WelshKind[] = ["info", "search"];
export const MAX_RUNNING_QUICK = 2;

/** Under the hub's 15 minutes for any job, so an answer is never thrown away. A quick one the page is still waiting for is read back once the hub stops waiting, so a minute is not too long for it. */
const TIMEOUT_MS: Record<WelshKind, number> = {
  info: 60_000,
  search: 60_000,
  scan: 10 * 60_000,
  import_check: 3 * 60_000,
  import: 5 * 60_000,
  apply_preview: 12 * 60_000,
  apply: 14 * 60_000,
  story_candidates: 2 * 60_000,
  story_preview: 2 * 60_000,
  story_write: 3 * 60_000
};

const MAX_DETAIL = 500;
const MAX_MESSAGE = 4000;
const MAX_STRINGS = 200;
const MAX_STRING = 2000;
const MAX_CHOICES = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRODUCT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-[0-9]{1,7}$/;
const REF_RE = /^CY-[0-9A-F]{8}$/;
const ROW_ID_RE = /^[0-9a-f]{10}$/;
const FILE_NAME_RE = /^[\p{L}\p{N} ._()-]{1,195}\.xlsx$/iu;

export type WelshChoice = { ref: string; row_id: string };

/** A job as the sessions stream sends it, once every value has been checked. */
export type WelshFrame = {
  job_id: string;
  kind: WelshKind;
  product: string;
  query?: string;
  mode?: "contains" | "exact" | "fuzzy";
  repo?: string;
  file_id?: string;
  file_name?: string;
  key?: string;
  strings?: string[];
  choices?: WelshChoice[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isKind(value: unknown): value is WelshKind {
  return typeof value === "string" && (WELSH_KINDS as readonly string[]).includes(value);
}

function isRepoOf(product: string, path: unknown): path is string {
  if (typeof path !== "string") {
    return false;
  }
  const [apps, slug, name, ...rest] = path.split("/");
  return apps === "apps" && slug === product && rest.length === 0 && name !== undefined && REPO_NAME_RE.test(name) && name !== "." && name !== "..";
}

function choicesOf(value: unknown): WelshChoice[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_CHOICES) {
    return null;
  }
  const out: WelshChoice[] = [];
  for (const item of value) {
    const raw = asRecord(item);
    if (!raw || typeof raw.ref !== "string" || !REF_RE.test(raw.ref) || typeof raw.row_id !== "string" || !ROW_ID_RE.test(raw.row_id)) {
      return null;
    }
    out.push({ ref: raw.ref, row_id: raw.row_id });
  }
  return out;
}

/**
 * The job on a sessions stream frame, or null for anything that is not exactly one of the kinds with the arguments
 * that kind takes. The hub has checked all of this already; it is checked again because this is what reaches a process.
 */
export function parseWelshFrame(value: unknown): WelshFrame | null {
  const raw = asRecord(value);
  const args = asRecord(raw?.args);
  if (
    !raw ||
    !args ||
    typeof raw.job_id !== "string" ||
    !UUID_RE.test(raw.job_id) ||
    !isKind(raw.kind) ||
    typeof raw.product !== "string" ||
    !PRODUCT_RE.test(raw.product)
  ) {
    return null;
  }
  const frame: WelshFrame = { job_id: raw.job_id, kind: raw.kind, product: raw.product };
  const allowed = new Set<string>();
  const kind = raw.kind;
  if (kind === "search") {
    allowed.add("query").add("mode");
    if (typeof args.query !== "string" || args.query.trim() === "" || args.query.length > 100) {
      return null;
    }
    const mode = args.mode ?? "contains";
    if (mode !== "contains" && mode !== "exact" && mode !== "fuzzy") {
      return null;
    }
    frame.query = args.query.trim();
    frame.mode = mode;
  }
  if (kind === "scan" || kind === "apply_preview" || kind === "apply") {
    allowed.add("repo");
    if (args.repo !== undefined) {
      if (!isRepoOf(raw.product, args.repo)) {
        return null;
      }
      frame.repo = args.repo;
    }
  }
  if (kind === "import_check" || kind === "import" || kind === "apply_preview" || kind === "apply") {
    allowed.add("file_id");
    const needed = kind === "import_check" || kind === "import";
    if (args.file_id === undefined ? needed : typeof args.file_id !== "string" || !UUID_RE.test(args.file_id)) {
      return null;
    }
    if (typeof args.file_id === "string") {
      frame.file_id = args.file_id;
      frame.file_name = typeof raw.file_name === "string" && FILE_NAME_RE.test(raw.file_name) ? raw.file_name : "welsh-return.xlsx";
    }
  }
  if (kind === "apply_preview" || kind === "apply" || kind === "story_preview") {
    allowed.add("choices");
    const choices = choicesOf(args.choices);
    if (choices === null) {
      return null;
    }
    frame.choices = choices;
  }
  if (kind === "story_candidates" || kind === "story_preview" || kind === "story_write") {
    allowed.add("key");
    if (typeof args.key !== "string" || !KEY_RE.test(args.key)) {
      return null;
    }
    frame.key = args.key;
  }
  if (kind === "story_preview") {
    allowed.add("strings");
    const strings = args.strings;
    if (!Array.isArray(strings) || strings.length === 0 || strings.length > MAX_STRINGS) {
      return null;
    }
    if (!strings.every((s): s is string => typeof s === "string" && s.trim() !== "" && s.length <= MAX_STRING && !/[\r\n]/.test(s))) {
      return null;
    }
    frame.strings = strings.map((s) => s.trim());
  }
  if (Object.keys(args).some((name) => !allowed.has(name))) {
    return null;
  }
  return frame;
}

/** Where a job's files go: the uploaded return it reads, and the spreadsheets it may make. */
export type WelshPaths = { dir: string; input: string; request: string; queries: string; strings: string };

export function welshPaths(dir: string, frame: Pick<WelshFrame, "file_name">): WelshPaths {
  return {
    dir,
    input: join(dir, frame.file_name ?? "welsh-return.xlsx"),
    request: join(dir, "request.xlsx"),
    queries: join(dir, "queries.xlsx"),
    strings: join(dir, "strings.txt")
  };
}

/**
 * The `scripts/welsh` arguments for a job. Values that came from the person go after `--` or as the value of a
 * named option, so none of them can be read as an option. A repo is passed as an absolute path under the workspace,
 * because the script resolves `--repo` against its working directory.
 */
export function welshArgs(frame: WelshFrame, workspace: string, paths: WelshPaths): string[] {
  const service = ["--service", frame.product];
  const repo = frame.repo ? ["--repo", join(workspace, frame.repo)] : [];
  const choices = (frame.choices ?? []).flatMap((c) => ["--choose", `${c.ref}=${c.row_id}`]);
  const from = ["--from", frame.file_id ? paths.input : "catalogue"];
  switch (frame.kind) {
    case "info":
      return ["info", ...service];
    case "search":
      return [
        "search",
        ...service,
        ...(frame.mode === "exact" ? ["--exact"] : frame.mode === "fuzzy" ? ["--fuzzy"] : []),
        "--limit",
        "25",
        "--",
        frame.query ?? ""
      ];
    case "scan":
      return ["scan", ...service, ...repo, "--out", paths.request];
    case "import_check":
      return ["import", ...service, "--dry-run", "--", paths.input];
    case "import":
      return ["import", ...service, "--pr", "--queries-out", paths.queries, "--", paths.input];
    case "apply_preview":
      return ["apply", ...service, ...repo, ...from, ...choices, "--dry-run"];
    case "apply":
      return ["apply", ...service, ...repo, ...from, ...choices, "--pr"];
    case "story_candidates":
      return ["story", ...service, "--", frame.key ?? ""];
    case "story_preview":
      return ["story", ...service, "--strings", paths.strings, ...choices, "--", frame.key ?? ""];
    case "story_write":
      return ["story", ...service, "--write", "--out", paths.request, "--", frame.key ?? ""];
  }
}

/** The spreadsheets a job may make, and the name each is offered to download as. */
export function welshOutputs(frame: WelshFrame, paths: WelshPaths, today: string): { path: string; name: string }[] {
  switch (frame.kind) {
    case "scan":
      return [{ path: paths.request, name: `${frame.product}-welsh-request-${today}.xlsx` }];
    case "story_write":
      return [{ path: paths.request, name: `${frame.key}-welsh-request-${today}.xlsx` }];
    case "import":
      return [{ path: paths.queries, name: `${(frame.file_name ?? "welsh-return.xlsx").replace(/\.xlsx$/i, "")}-queries.xlsx` }];
    default:
      return [];
  }
}

/** Which sign-in a failure was for want of, in words for the person, or null when it was something else. */
export function signInNeeded(output: string): string | null {
  if (/gh auth login|could not read Username|Authentication failed|Permission denied \(publickey\)|HTTP 401.*github|bad credentials/i.test(output)) {
    return "Your assistant needs you to sign in to GitHub again. Open Settings, then Sign-ins.";
  }
  if (/AUTH_REQUIRED|twg (auth )?login|not signed in to Atlassian|exit(ed)? (code )?77/i.test(output)) {
    return "Your assistant needs you to sign in to Atlassian (Jira) again. Open Settings, then Sign-ins.";
  }
  return null;
}

/** Why the script failed, in at most `MAX_DETAIL` characters: its own message, without the usage line or a stack. */
export function failureDetail(stderr: string, code: number): string {
  if (code === 127) {
    return "Your assistant's copy of cft-workspace does not have the Welsh tools yet. Restart your assistant to update it.";
  }
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("usage:") && !/^at\s/.test(line));
  const message = lines.find((line) => line.startsWith("welsh ") || /^Error:/.test(line)) ?? lines.at(-1) ?? "";
  const clean = message.replace(/^welsh \w[\w-]*: /, "").replace(/^Error: /, "");
  const text = clean === "" ? "That did not work. Try again." : clean;
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

export type WelshDeps = {
  api: Pick<Api, "putWelsh" | "putWelshFile" | "welshFile">;
  /** The virtual agent's id. */
  id: string;
  run: Run;
  env: Env;
  /** The cft-workspace checkout; `$VIRTUAL_AGENT_WORKSPACE` in a pod. */
  workspace: string;
  say?: (message: string) => void;
  now?: () => Date;
};

/** Runs one job and answers it, uploading the spreadsheets it made first. Never throws. */
export async function runWelsh(deps: WelshDeps, frame: WelshFrame): Promise<void> {
  const say = deps.say ?? (() => {});
  const dir = mkdtempSync(join(tmpdir(), "welsh-job-"));
  let answer: WelshAnswer;
  try {
    answer = await runIn(deps, frame, welshPaths(dir, frame));
  } catch (e) {
    answer = { error: "failed", detail: `That did not work: ${(e as Error).message}`.slice(0, MAX_DETAIL) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    await withRetry(() => deps.api.putWelsh(deps.id, frame.job_id, answer), { attempts: 2 });
  } catch (e) {
    say(`welsh ${frame.job_id}: could not answer it: ${(e as Error).message}`);
  }
}

async function runIn(deps: WelshDeps, frame: WelshFrame, paths: WelshPaths): Promise<WelshAnswer> {
  const script = join(deps.workspace, "scripts", "welsh");
  if (!existsSync(script)) {
    return { error: "failed", detail: failureDetail("", 127) };
  }
  if (frame.file_id) {
    writeFileSync(paths.input, await deps.api.welshFile(deps.id, frame.file_id));
  }
  if (frame.strings) {
    writeFileSync(paths.strings, `${frame.strings.join("\n")}\n`);
  }
  const result = await deps.run(script, welshArgs(frame, deps.workspace, paths), { env: deps.env, timeoutMs: TIMEOUT_MS[frame.kind] });
  const signIn = signInNeeded(`${result.stderr}\n${result.stdout}`);
  if (result.code !== 0) {
    return signIn ? { error: "signed_out", detail: signIn } : { error: "failed", detail: failureDetail(result.stderr, result.code) };
  }
  let printed: unknown;
  try {
    printed = JSON.parse(result.stdout);
  } catch {
    return { error: "failed", detail: "The Welsh tools answered with something that is not a result." };
  }
  const body = asRecord(printed);
  if (!body) {
    return { error: "failed", detail: "The Welsh tools answered with something that is not a result." };
  }
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  for (const output of welshOutputs(frame, paths, today)) {
    if (existsSync(output.path)) {
      await withRetry(() => deps.api.putWelshFile(deps.id, frame.job_id, output.name, readFileSync(output.path)), { attempts: 2 });
    }
  }
  // What the script told a person at a terminal, for the page to show beside the figures it reads.
  return { result: { ...body, message: result.stderr.trim().slice(0, MAX_MESSAGE) } };
}

export type WelshRunner = {
  /** Takes a `welsh` frame's data and runs it as soon as there is room. */
  welsh: (data: unknown) => void;
  /** Resolves once nothing is running or waiting; for a test, and for the supervisor's shutdown. */
  idle: () => Promise<void>;
};

/**
 * Runs jobs beside the supervisor rather than behind it. Quick ones (`info`, `search`) run at most two at once,
 * since somebody is waiting on the page; the rest run one at a time, in the order they were started, because each
 * may clone, branch and push, and two at once in one checkout would get in each other's way.
 */
export function createWelshRunner(deps: WelshDeps & { maxQuick?: number }): WelshRunner {
  const say = deps.say ?? (() => {});
  const maxQuick = deps.maxQuick ?? MAX_RUNNING_QUICK;
  const quick: WelshFrame[] = [];
  let quickRunning = 0;
  let long: Promise<void> = Promise.resolve();
  const running = new Set<Promise<void>>();

  const track = (job: Promise<void>) => {
    running.add(job);
    void job.finally(() => running.delete(job));
  };

  function pumpQuick(): void {
    while (quickRunning < maxQuick && quick.length > 0) {
      const frame = quick.shift() as WelshFrame;
      quickRunning++;
      track(
        runWelsh(deps, frame).finally(() => {
          quickRunning--;
          pumpQuick();
        })
      );
    }
  }

  return {
    welsh(data) {
      const frame = parseWelshFrame(data);
      if (!frame) {
        say(`ignoring a Welsh job that is not one: ${JSON.stringify(data).slice(0, 200)}`);
        return;
      }
      if (QUICK.includes(frame.kind)) {
        quick.push(frame);
        pumpQuick();
      } else {
        long = long.then(() => runWelsh(deps, frame));
        track(long);
      }
    },
    async idle() {
      while (running.size > 0 || quick.length > 0) {
        await Promise.all([...running]);
      }
    }
  };
}
