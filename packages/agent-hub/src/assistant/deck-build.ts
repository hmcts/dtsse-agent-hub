// The supervisor's half of a deck build, for the slides panel's download of an older version: one run of the slides
// plugin's `scripts/slides build`, from the pod's copy of it, on the version's outline and pictures as the hub holds
// them. Every value in the frame is checked again here, and each argument is passed on its own, never through a shell.
// See "Deck builds" in dtsse-agent-hub's docs/agent-api.md.
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api } from "../api.ts";
import { materialise } from "../cli/deck.ts";
import type { Env } from "../env.ts";
import { withRetry } from "../retry.ts";
import type { Run } from "./lookups.ts";
import { bundledScript, MIN_RUN_MS, readyWithin, reason, safeSay } from "./plugin-deps.ts";

/** The plugin that carries `scripts/slides`, and the name the owner ticks. */
export const SLIDES_PLUGIN = "slides";

/** Under the hub's 15 minutes for a build, so an answer is never thrown away. */
export const BUILD_BUDGET_MS = 14 * 60_000;

/** The hub's limits: a .pptx of at most 5 MiB, and an error of at most 2000 characters. */
const MAX_PPTX_BYTES = 5 * 1024 * 1024;
const MAX_ERROR = 2000;

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export const NOT_LOADED =
  "Slides is not turned on for your assistant. Tick it in Settings, under Plugins. If you have just ticked it, your assistant is restarting to load it: try again in a minute or two.";
export const TOO_SLOW = "Building the slides took too long. Try again.";
/** What a build answers when the slides tools' first install has taken so long that the build could not finish in time. */
export const STILL_PREPARING = "Your assistant is still setting up the slides tools. Try again in a few minutes.";

export type DeckBuildFrame = { job_id: string; conversation_id: string; version: number };

/** The build on a sessions stream frame, or null for anything that is not exactly one. */
export function parseDeckBuildFrame(value: unknown): DeckBuildFrame | null {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!raw || typeof raw.job_id !== "string" || !UUID_RE.test(raw.job_id) || typeof raw.conversation_id !== "string" || !UUID_RE.test(raw.conversation_id)) {
    return null;
  }
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    return null;
  }
  return { job_id: raw.job_id, conversation_id: raw.conversation_id, version: raw.version };
}

const clip = (text: string): string => (text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text);

/** What a build that did not make a .pptx says to the person, from what `scripts/slides` printed. */
export function buildFailure(stdout: string, stderr: string, code: number): string {
  if (code === 127) {
    return "Your assistant could not start the slides tools. Restart your assistant, then try again.";
  }
  let printed: unknown;
  try {
    printed = JSON.parse(stdout);
  } catch {
    printed = null;
  }
  const body = typeof printed === "object" && printed !== null ? (printed as { errors?: unknown; error?: unknown }) : {};
  if (code === 2 && Array.isArray(body.errors) && body.errors.length > 0) {
    return clip(`This version could not be built: ${body.errors.map(String).join("; ")}`);
  }
  if (typeof body.error === "string" && body.error.trim() !== "") {
    return clip(`The slides tools failed: ${body.error.trim()}`);
  }
  const last = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("at "))
    .at(-1);
  return clip(last === undefined ? `The slides tools stopped (exit ${code}). Try again.` : `The slides tools stopped: ${last}`);
}

export type DeckBuildDeps = {
  api: Pick<Api, "deckBuild" | "deckBuildAsset" | "putDeckBuild">;
  /** The virtual agent's id. */
  id: string;
  run: Run;
  env: Env;
  /** The cft-workspace checkout; the pod's plugin copies sit beside it. */
  workspace: string;
  install?: (name: string, workspace: string) => string;
  /** Settles once the slides tools' dependencies are installed, or the attempt has failed: the pod's start-up `prepareEach`. */
  ready?: Promise<void>;
  say?: (message: string) => void;
  /** Milliseconds since the epoch, for the build's budget; a test passes its own. */
  clock?: () => number;
  budgetMs?: number;
};

/** Builds one version, once the slides tools are installed, and answers the hub with the .pptx or why there is none. Never throws. */
export async function runDeckBuild(deps: DeckBuildDeps, frame: DeckBuildFrame): Promise<void> {
  const say = safeSay(deps.say);
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + (deps.budgetMs ?? BUILD_BUDGET_MS);
  let dir: string | undefined;
  let answer: { pptx: Uint8Array } | { error: string };
  try {
    // The wait for the tools' first install comes out of the build's budget, so wait and build end inside the hub's limit.
    if (await readyWithin(deps.ready, deadline - clock() - MIN_RUN_MS)) {
      dir = fs.mkdtempSync(path.join(tmpdir(), "deck-build-"));
      answer = await buildIn(deps, frame, dir, deadline, clock);
    } else {
      answer = { error: STILL_PREPARING };
    }
  } catch (e) {
    answer = { error: clip(`This version could not be built: ${reason(e)}`) };
  } finally {
    if (dir !== undefined) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        say(`deck build ${frame.job_id}: could not remove ${dir}: ${reason(e)}`);
      }
    }
  }
  try {
    await withRetry(() => deps.api.putDeckBuild(deps.id, frame.job_id, answer), { attempts: 2 });
  } catch (e) {
    say(`deck build ${frame.job_id}: could not answer it: ${reason(e)}`);
  }
}

async function buildIn(
  deps: DeckBuildDeps,
  frame: DeckBuildFrame,
  dir: string,
  deadline: number,
  clock: () => number
): Promise<{ pptx: Uint8Array } | { error: string }> {
  const script = bundledScript(SLIDES_PLUGIN, deps.workspace, deps.env, deps.install);
  if (script === null) {
    return { error: NOT_LOADED };
  }
  const build = await deps.api.deckBuild(deps.id, frame.job_id);
  if (build.version !== frame.version || build.conversation_id !== frame.conversation_id) {
    return { error: "The hub sent a different version from the one asked for. Try again." };
  }
  const outline = await materialise((sha) => deps.api.deckBuildAsset(deps.id, frame.job_id, sha), build.outline, dir);
  const outlineFile = path.join(dir, "outline.json");
  const out = path.join(dir, "deck.pptx");
  fs.writeFileSync(outlineFile, `${JSON.stringify(outline, null, 2)}\n`);
  const timeoutMs = deadline - clock();
  if (timeoutMs <= 0) {
    return { error: TOO_SLOW };
  }
  const started = clock();
  const result = await deps.run(script, ["build", outlineFile, "--out", out], { env: deps.env, timeoutMs });
  if (result.code !== 0) {
    return { error: clock() - started >= timeoutMs ? TOO_SLOW : buildFailure(result.stdout, result.stderr, result.code) };
  }
  if (!fs.existsSync(out)) {
    return { error: "The slides tools finished without writing the deck. Try again." };
  }
  const bytes = fs.readFileSync(out);
  if (bytes.byteLength > MAX_PPTX_BYTES) {
    return { error: `This version builds to more than the ${MAX_PPTX_BYTES} bytes the hub keeps; it cannot be downloaded.` };
  }
  return { pptx: bytes };
}

export type DeckBuildRunner = {
  /** Takes a `deck_build` frame's data and builds it once the builds before it are done. */
  deckBuild: (data: unknown) => void;
  /** Resolves once nothing is running or waiting; for a test, and for the supervisor's shutdown. */
  idle: () => Promise<void>;
};

/** Runs builds beside the supervisor, one at a time in the order they came, since each is a whole Node process. */
export function createDeckBuildRunner(deps: DeckBuildDeps): DeckBuildRunner {
  const say = safeSay(deps.say);
  let chain: Promise<void> = Promise.resolve();
  return {
    deckBuild(data) {
      const frame = parseDeckBuildFrame(data);
      if (!frame) {
        say(`ignoring a deck build that is not one: ${JSON.stringify(data).slice(0, 200)}`);
        return;
      }
      // The budget runs from the frame's arrival, so a build that waited behind others still answers inside the hub's 15 minutes.
      const arrived = (deps.clock ?? Date.now)();
      // Each link catches its own failure, so one build that throws neither skips the builds behind it nor goes unhandled.
      chain = chain
        .then(() => runDeckBuild({ ...deps, budgetMs: (deps.budgetMs ?? BUILD_BUDGET_MS) - ((deps.clock ?? Date.now)() - arrived) }, frame))
        .catch((e: unknown) => say(`deck build ${frame.job_id} failed: ${reason(e)}`));
    },
    idle: () => chain
  };
}
