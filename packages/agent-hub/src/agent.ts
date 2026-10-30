// What this session is to agent-hub: the repository it is working in, the topics that follow from that, the
// registration that turns it into an agent, and the bridge process that keeps it connected.
//
// The workspace layout read here — `apps/<product>/<repo>`, `libs/<repo>`, `platops/<repo>` — is cft-workspace's.
// It is not configurable: that checkout is the only one this client runs in, and a setting no one would ever change
// would only be another way for the layout and the code to disagree.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api } from "./api.ts";
import type { Env } from "./env.ts";
import { CLIENT_FEATURES } from "./features.ts";
import {
  conversationId,
  ensureStateDir,
  log,
  pidAlive,
  projectDir,
  readJson,
  readPidFile,
  removeFile,
  sessionInfo,
  spawnDetached,
  statePath,
  writeJson
} from "./session.ts";
import { collectSkills as collectSkillsDefault, type SkillListing, skillsHash } from "./skills.ts";

export const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function normaliseTopic(raw: unknown): string | null {
  const slug = String(raw).trim().toLowerCase();
  return TOPIC_RE.test(slug) ? slug : null;
}

export type NormalisedTopics = {
  good: string[];
  bad: string[];
};

export function normaliseTopics(list: readonly unknown[]): NormalisedTopics {
  const good: string[] = [];
  const bad: string[] = [];
  for (const raw of list) {
    for (const part of String(raw).split(",")) {
      if (!part.trim()) {
        continue;
      }
      const slug = normaliseTopic(part);
      if (slug) {
        if (!good.includes(slug)) {
          good.push(slug);
        }
      } else {
        bad.push(part.trim());
      }
    }
  }
  return { good, bad };
}

// A repo name may carry characters a slug can't, e.g. dots.
export function slugify(raw: unknown): string | null {
  const slug = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return TOPIC_RE.test(slug) ? slug : null;
}

export function jiraKey(branch: string | null | undefined): string | null {
  const m = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]+-\d+)(?![0-9])/.exec(branch || "");
  return m ? (m[1] as string).toLowerCase() : null;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

export function repoName(cwd: string): string | null {
  const url = git(cwd, ["remote", "get-url", "origin"]);
  if (url) {
    return path.basename(url.replace(/\/+$/, "")).replace(/\.git$/, "");
  }
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return top ? path.basename(top) : null;
}

export function gitBranch(dir: string): string | null {
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return branch && branch !== "HEAD" ? branch : null;
}

const workspaceRoots = new Map<string, string>();

// The workspace checkout every layout lookup below is relative to: the nearest directory at or above the
// project directory holding `workspace.yaml`, cft-workspace's manifest of the repos it clones. The project
// directory cannot stand in for it, because a session started inside a clone — `cd apps/pcs/pcs-api && claude`
// — has that clone as its project directory, which is inside the layout rather than the top of it. Falls back
// to the git toplevel, then to the project directory itself.
export function workspaceRoot(start: string = projectDir()): string {
  const cached = workspaceRoots.get(start);
  if (cached !== undefined) {
    return cached;
  }
  const found = findWorkspaceRoot(start);
  workspaceRoots.set(start, found);
  return found;
}

function findWorkspaceRoot(start: string): string {
  const from = path.resolve(start);
  let dir = from;
  let parent = path.dirname(dir);
  while (!fs.existsSync(path.join(dir, "workspace.yaml"))) {
    if (parent === dir) {
      return git(from, ["rev-parse", "--show-toplevel"]) || from;
    }
    dir = parent;
    parent = path.dirname(dir);
  }
  return dir;
}

// The longest existing prefix of a path, resolved, with the rest of it appended. `fs.realpathSync` answers for
// the whole path or not at all, and a path taken from a transcript can name a file a tool has since deleted or
// is about to write; resolving the directories above it is enough to compare it with the workspace root.
function realpath(p: string): string {
  const resolved = path.resolve(p);
  const rest: string[] = [];
  let dir = resolved;
  while (dir !== path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync(dir), ...rest);
    } catch {
      rest.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
  return resolved;
}

// Both sides are resolved, because the root is not always spelled the way the paths compared against it are:
// with no `workspace.yaml` above the session, `workspaceRoot` falls back to the git toplevel, which git reports
// realpathed, while the paths in a transcript keep whatever symlinked spelling the session used. Comparing the
// two raw put every one of them outside the root. Resolving is a no-op for a path that is already real, and
// `realpath` falls back to `path.resolve` for one that does not exist.
function relativeTo(root: string, p: string): string | null {
  const rel = path.relative(realpath(root), realpath(p));
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel;
}

export type AgentMetadata = {
  session_id: string;
  name: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
  host: string;
};

export type GatherMetadataOptions = {
  cwd?: string | null;
  root?: string;
};

// A cwd in the workspace but outside a clone says nothing about the repo being worked on, which is the common
// case: sessions are often run from the workspace root so that they share their history.
export function gatherMetadata(sid: string, { cwd, root = workspaceRoot() }: GatherMetadataOptions = {}): AgentMetadata {
  const info = sessionInfo(sid);
  const dir = cwd || info.cwd || process.cwd();
  const rel = relativeTo(root, dir);
  const repoDir = rel === null ? dir : cloneDir(rel, root);
  return {
    session_id: sid,
    name: info.name,
    cwd: dir,
    repo: repoDir ? repoName(repoDir) : null,
    branch: repoDir ? gitBranch(repoDir) : null,
    host: os.hostname()
  };
}

const workspaceNames = new Map<string, string | null>();

export function workspaceRepoName(root: string = workspaceRoot()): string | null {
  if (!workspaceNames.has(root)) {
    workspaceNames.set(root, slugify(repoName(root) || path.basename(root)));
  }
  return workspaceNames.get(root) ?? null;
}

const CONTAINERS = new Set(["libs", "platops"]);

export type WorkspacePlace = {
  product: string;
  repo: string | null;
};

// Where a path sits in the workspace layout: apps/<product>/<repo>, libs/<repo> or platops/<repo>.
// Relative paths are taken from the workspace root; absolute ones must be under it.
export function workspacePlace(p: string | null | undefined, root: string = workspaceRoot()): WorkspacePlace | null {
  if (typeof p !== "string" || !p) {
    return null;
  }
  let rel = p;
  if (path.isAbsolute(p)) {
    const under = relativeTo(root, p);
    if (!under) {
      return null;
    }
    rel = under;
  }
  const [head, second, third] = rel.split(/[\\/]+/).filter((part) => part && part !== ".");
  let product: string | null;
  let repo: string | undefined;
  if (head === "apps" && second) {
    product = slugify(second);
    repo = third;
  } else if (head && CONTAINERS.has(head)) {
    product = head;
    repo = second;
  } else {
    return null;
  }
  if (!product) {
    return null;
  }
  return { product, repo: repo && isRepoDir(repo) ? slugify(repo) : null };
}

// Product directories also hold workspace-tracked docs and plugin files next to the clones.
function isRepoDir(name: string): boolean {
  return /^[A-Za-z0-9]/.test(name) && name !== "docs" && !/\.(md|ya?ml|json)$/i.test(name);
}

function relParts(rel: string): string[] {
  return rel.split(/[\\/]+/).filter((part) => part && part !== ".");
}

// The clone directory a workspace-relative path sits in, or null when it is not inside a clone.
export function cloneDir(rel: string, root: string = workspaceRoot()): string | null {
  const parts = relParts(rel);
  const depth = parts[0] === "apps" ? 3 : 2;
  if (parts.length < depth || !workspacePlace(parts.join("/"), root)?.repo) {
    return null;
  }
  return path.join(root, ...parts.slice(0, depth));
}

export type TouchPlace = {
  repo: string;
  product: string | null;
  dir: string;
};

// What an absolute path touched: a clone (its repo and product), or a file the workspace repo
// itself owns (scripts, skills, docs, product docs and plugins). The root and the bare container
// directories are no one's, and paths outside the root are ignored.
export function touchPlace(
  p: string | null | undefined,
  root: string = workspaceRoot(),
  workspaceRepo: string | null = workspaceRepoName(root)
): TouchPlace | null {
  if (typeof p !== "string" || !path.isAbsolute(p)) {
    return null;
  }
  const rel = relativeTo(root, path.resolve(p));
  if (!rel) {
    return null;
  }
  const parts = relParts(rel);
  const head = parts[0];
  if (head === "apps" || (head && CONTAINERS.has(head))) {
    if (parts.length < (head === "apps" ? 3 : 2)) {
      return null;
    }
    const place = workspacePlace(rel, root);
    if (place?.repo) {
      // A path the layout gives a repo to is inside a clone, so `cloneDir` answers for the same parts.
      return { repo: place.repo, product: place.product, dir: cloneDir(rel, root) as string };
    }
    return workspaceRepo ? { repo: workspaceRepo, product: place?.product ?? null, dir: root } : null;
  }
  return workspaceRepo ? { repo: workspaceRepo, product: null, dir: root } : null;
}

export type TopicMetadata = {
  repo?: string | null;
  branch?: string | null;
  cwd?: string | null;
};

export function autoTopics(meta: TopicMetadata): string[] {
  const product = workspacePlace(meta.cwd)?.product;
  return [...new Set([meta.repo ? slugify(meta.repo) : null, product, jiraKey(meta.branch)].filter((topic): topic is string => Boolean(topic)))];
}

// Everything agent.json may hold, all of it optional: a handoff from /clear writes only part of it, and an older
// version of this client on the same machine may have written a different part.
export type StoredAgent = {
  agent_id?: string;
  name?: string;
  session_id?: string;
  repo?: string | null;
  branch?: string | null;
  cwd?: string | null;
  claude_pid?: number | null;
  registered_at?: string;
  skills_hash?: string;
  topics?: string[];
  pending_subscribe?: string[];
  handed_off_from?: string;
  /** Set only for a pod's CFT Workspace conversation session, which registers with it. */
  conversation_id?: string;
};

/** What `registerAgent` writes: a saved agent the hub has answered for. */
export type RegisteredAgent = StoredAgent & {
  agent_id: string;
  name: string;
  session_id: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  return typeof value === "string" ? value : value === null ? null : undefined;
}

/** Null for a file that is not an object. Every field is dropped unless it has the shape this module writes. */
export function parseAgent(value: unknown): StoredAgent | null {
  const raw = asRecord(value);
  if (!raw) {
    return null;
  }
  return {
    agent_id: asString(raw.agent_id),
    name: asString(raw.name),
    session_id: asString(raw.session_id),
    repo: asNullableString(raw.repo),
    branch: asNullableString(raw.branch),
    cwd: asNullableString(raw.cwd),
    claude_pid: Number.isInteger(raw.claude_pid) ? (raw.claude_pid as number) : null,
    registered_at: asString(raw.registered_at),
    skills_hash: asString(raw.skills_hash),
    topics: asStrings(raw.topics),
    pending_subscribe: asStrings(raw.pending_subscribe),
    handed_off_from: asString(raw.handed_off_from),
    conversation_id: asString(raw.conversation_id)
  };
}

export function loadAgent(sid: string): StoredAgent | null {
  return parseAgent(readJson(statePath(sid, "agent.json")));
}

export type RegisterAgentOptions = GatherMetadataOptions & {
  collectSkills?: () => SkillListing[];
  /** Only `AGENT_HUB_CONVERSATION_ID` is read from it: which conversation, if any, this session is. */
  env?: Env;
};

export type RegisterAgentResult = {
  agent: RegisteredAgent;
  meta: AgentMetadata;
};

export async function registerAgent(api: Pick<Api, "register" | "subscribe">, sid: string, opts: RegisterAgentOptions = {}): Promise<RegisterAgentResult> {
  const meta = gatherMetadata(sid, opts);
  const skills = (opts.collectSkills || collectSkillsDefault)();
  const conversation = conversationId(opts.env);
  // `client_features` goes on every register, empty list included: it replaces what the hub has stored for this
  // session, so the hub always knows which build is running rather than which one ran first.
  const res = await api.register({
    ...meta,
    skills,
    client_features: [...CLIENT_FEATURES],
    ...(conversation ? { conversation_id: conversation } : {})
  });
  ensureStateDir(sid);
  const previous = loadAgent(sid) || {};
  const agent: RegisteredAgent = {
    ...previous,
    agent_id: res.agent_id,
    name: res.name || meta.name,
    session_id: sid,
    repo: meta.repo,
    branch: meta.branch,
    cwd: meta.cwd,
    claude_pid: sessionInfo(sid).pid || previous.claude_pid || null,
    registered_at: new Date().toISOString(),
    skills_hash: skillsHash(skills)
  };
  if (conversation) {
    agent.conversation_id = conversation;
  }
  if (agent.pending_subscribe?.length) {
    await api.subscribe(agent.agent_id, agent.pending_subscribe);
    delete agent.pending_subscribe;
  }
  writeJson(statePath(sid, "agent.json"), agent);
  return { agent, meta };
}

export function bridgePid(sid: string): number | null {
  const pid = readPidFile(statePath(sid, "bridge.pid"));
  return pid && pidAlive(pid) ? pid : null;
}

export type EnsureBridgeResult = {
  pid: number;
  started: boolean;
};

export async function ensureBridge(sid: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<EnsureBridgeResult> {
  const running = bridgePid(sid);
  if (running) {
    return { pid: running, started: false };
  }
  removeFile(statePath(sid, "bridge.stop"));
  const pid = await spawnDetached(sid, ["bridge", "--session", sid], { env });
  log(sid, `spawned bridge pid ${pid}`);
  return { pid, started: true };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns true if a running bridge exited (it posts offline itself on the way out).
export async function stopBridge(sid: string, { waitMs = 3000 }: { waitMs?: number } = {}): Promise<boolean> {
  ensureStateDir(sid);
  fs.writeFileSync(statePath(sid, "bridge.stop"), `${Date.now()}\n`);
  const pid = bridgePid(sid);
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      return true;
    }
    await sleep(50);
  }
  return !pidAlive(pid);
}
