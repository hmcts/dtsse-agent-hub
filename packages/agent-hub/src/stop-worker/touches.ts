// What the main thread's tool calls touched, by repo and product. The summariser uses this twice: as the
// topic candidates it offers the model, and as the signal that the session has moved to a different repo.
import path from "node:path";
import { touchPlace, workspaceRepoName, workspaceRoot } from "../agent.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

export type TouchKind = "edit" | "bash" | "read";

const WEIGHT: Record<TouchKind, number> = { edit: 3, bash: 2, read: 1 };

/** A word a shell command is made of, flagged when it still holds an expansion, so what it names is unknown. */
export type ShellWord = {
  word: string;
  dynamic: boolean;
};

export type ShellSeparator = {
  separator: string;
};

export type ShellToken = ShellWord | ShellSeparator;

// Splits a shell command into words and separators, honouring quotes. Words that still hold an
// expansion are marked, since what they name is unknown.
export function shellWords(command: string): ShellToken[] {
  const out: ShellToken[] = [];
  let word: string | null = null;
  let dynamic = false;
  const flush = () => {
    if (word !== null) {
      out.push({ word, dynamic });
    }
    word = null;
    dynamic = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const quoted = end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      if (c === '"' && /[$`]/.test(quoted)) {
        dynamic = true;
      }
      word = (word ?? "") + quoted;
      i = end === -1 ? command.length : end;
    } else if (c === "\\" && i + 1 < command.length) {
      word = (word ?? "") + command.charAt(++i);
    } else if (c === " " || c === "\t") {
      flush();
    } else if ("&|;()\n".includes(c)) {
      flush();
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        i++;
      }
      out.push({ separator: c === "&" || c === "|" ? (two === "&&" || two === "||" ? two : c) : c });
    } else {
      if (c === "$" || c === "`" || c === "*" || c === "?") {
        dynamic = true;
      }
      word = (word ?? "") + c;
    }
  }
  flush();
  return out;
}

const HOME_RE = /^~(?:\/|$)/;

// The paths a Bash command works in: cd/pushd targets, git -C directories, absolute paths, and
// workspace paths relative to where the command stands. Relative paths start from the root.
export function bashPaths(command: string, root: string): string[] {
  const paths: string[] = [];
  let cwd: string | null = root;
  const words = shellWords(command);
  // Null for a token that is a separator as well as for one past the end: a word is wanted in both places
  // this is asked, and neither answers one.
  const wordAt = (index: number): ShellWord | null => {
    const token = words[index];
    return token && "word" in token ? token : null;
  };
  const resolve = (w: ShellWord): string | null => {
    if (w.dynamic || HOME_RE.test(w.word) || w.word === "-") {
      return null;
    }
    if (path.isAbsolute(w.word)) {
      return path.resolve(w.word);
    }
    return cwd ? path.resolve(cwd, w.word) : null;
  };
  for (let i = 0; i < words.length; i++) {
    const w = wordAt(i);
    if (!w) {
      continue;
    }
    const atStart = i === 0 || !wordAt(i - 1);
    if (atStart && (w.word === "cd" || w.word === "pushd")) {
      let j = i + 1;
      let flag = wordAt(j);
      while (flag?.word.startsWith("-") && flag.word !== "-") {
        j++;
        flag = wordAt(j);
      }
      const target = wordAt(j);
      const dir = target ? resolve(target) : null;
      if (dir) {
        paths.push(dir);
      }
      cwd = dir;
      i = target ? j : i;
      continue;
    }
    if (w.word === "git") {
      for (let j = i + 1; ; j++) {
        const option = wordAt(j);
        if (!option?.word.startsWith("-")) {
          break;
        }
        const next = wordAt(j + 1);
        if (option.word === "-C" && next) {
          const dir = resolve(next);
          if (dir) {
            paths.push(dir);
          }
          j++;
        }
      }
      continue;
    }
    if (w.dynamic) {
      continue;
    }
    const value = w.word.replace(/^--?[\w-]+=/, "");
    if (path.isAbsolute(value)) {
      paths.push(path.resolve(value));
    } else if (cwd && /^(?:\.\/)?(?:apps|libs|platops)\/./.test(value)) {
      paths.push(path.resolve(cwd, value));
    }
  }
  return paths;
}

type Touch = {
  kind: TouchKind;
  paths: (string | null)[];
};

function asPath(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toolTouch(name: string, input: Record<string, unknown>, root: string): Touch | null {
  if (EDIT_TOOLS.has(name)) {
    return { kind: "edit", paths: [asPath(input.file_path ?? input.notebook_path)] };
  }
  if (READ_TOOLS.has(name)) {
    const p = asPath(input.file_path ?? input.path);
    return { kind: "read", paths: [p !== null && !path.isAbsolute(p) ? path.resolve(root, p) : p] };
  }
  if (name === "Bash" && typeof input.command === "string") {
    return { kind: "bash", paths: bashPaths(input.command, root) };
  }
  return null;
}

type Weighted = {
  slug: string;
  weight: number;
  workedIn: boolean;
  edited: boolean;
};

/** A repo the session touched, with the clone it sits in and the products its touched files belong to. */
export type RepoTouch = Weighted & {
  dir: string;
  products: string[];
};

/** A workspace product the session touched. */
export type ProductTouch = Weighted;

export type Touches = {
  repos: RepoTouch[];
  products: ProductTouch[];
};

type RepoEntry = Weighted & {
  dir: string;
  products: Set<string>;
};

function weigh(entry: Weighted, kind: TouchKind): void {
  entry.weight += WEIGHT[kind];
  entry.workedIn ||= kind !== "read";
  entry.edited ||= kind === "edit";
}

// Insertion order breaks a tie, because Array.prototype.sort is stable: the repo touched first stays first.
function heaviestFirst<T extends Weighted>(entries: Iterable<T>): T[] {
  return [...entries].sort((a, b) => b.weight - a.weight);
}

export type ExtractTouchesOptions = {
  root?: string;
  workspaceRepo?: string | null;
};

type ToolUse = {
  name: string;
  input: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The tool calls on one transcript line, or none: sidechain lines are another agent's work, not this session's. */
function toolUses(line: string): ToolUse[] {
  let entry: Record<string, unknown> | null;
  try {
    entry = asRecord(JSON.parse(line));
  } catch {
    return [];
  }
  const content = entry && !entry.isSidechain && entry.type === "assistant" ? asRecord(entry.message)?.content : null;
  if (!Array.isArray(content)) {
    return [];
  }
  const uses: ToolUse[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    const input = part?.type === "tool_use" ? asRecord(part.input) : null;
    if (input && typeof part?.name === "string") {
      uses.push({ name: part.name, input });
    }
  }
  return uses;
}

// What the main thread's tool calls touched, by repo and product, heaviest first. Edits weigh 3,
// Bash 2 and reads 1, each counted once per tool call. A repo or product is worked in when an
// edit or a Bash command touched it; `edited` is for edits alone.
export function extractTouches(jsonl: string, { root = workspaceRoot(), workspaceRepo = workspaceRepoName(root) }: ExtractTouchesOptions = {}): Touches {
  const repos = new Map<string, RepoEntry>();
  const products = new Map<string, ProductTouch>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    for (const use of toolUses(line)) {
      const touch = toolTouch(use.name, use.input, root);
      if (!touch) {
        continue;
      }
      const places = new Map<string, { dir: string; products: Set<string> }>();
      for (const p of touch.paths) {
        const place = touchPlace(p, root, workspaceRepo);
        if (!place) {
          continue;
        }
        const seen = places.get(place.repo) || { dir: place.dir, products: new Set<string>() };
        if (place.product) {
          seen.products.add(place.product);
        }
        places.set(place.repo, seen);
      }
      const touchedProducts = new Set<string>();
      for (const [repo, { dir, products: repoProducts }] of places) {
        const entry = repos.get(repo) || { slug: repo, weight: 0, workedIn: false, edited: false, dir, products: new Set<string>() };
        weigh(entry, touch.kind);
        repos.set(repo, entry);
        for (const product of repoProducts) {
          touchedProducts.add(product);
          if (touch.kind !== "read") {
            entry.products.add(product);
          }
        }
      }
      for (const product of touchedProducts) {
        const entry = products.get(product) || { slug: product, weight: 0, workedIn: false, edited: false };
        weigh(entry, touch.kind);
        products.set(product, entry);
      }
    }
  }
  return {
    repos: heaviestFirst(repos.values()).map(({ products: repoProducts, ...rest }) => ({ ...rest, products: [...repoProducts] })),
    products: heaviestFirst(products.values()).map((entry) => ({ ...entry }))
  };
}

export const NO_TOUCHES: Touches = Object.freeze({ repos: [], products: [] });

// A repo counts as worked in for the registration and subscriptions when an edit or a Bash command
// touched it; the workspace repo only when its own files were edited.
export function workedInRepos(touches: Touches | null | undefined, workspaceRepo: string | null): RepoTouch[] {
  return (touches?.repos || []).filter((r) => r.workedIn && (r.slug !== workspaceRepo || r.edited));
}
