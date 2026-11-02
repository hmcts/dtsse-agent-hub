// The plugins this package carries in its own `plugins/` directory, which the hub puts on a virtual agent whose
// owner ticked them: the hub offers them in VIRTUAL_AGENT_PLUGINS beside the workspace marketplace's, and the
// orchestrator passes the ticked names as AGENT_HUB_PLUGINS either way.
//
// A pod runs each from a copy on its own disk rather than from the package. The package sits under the global
// node_modules, where Node will not run TypeScript, and a client upgrade replaces it, taking any dependencies a
// plugin installed into it along. The copy is keyed by a hash of the plugin's files, so a new version gets a fresh
// one and an unchanged plugin keeps its installed dependencies across restarts, the copies being on the pod's disk.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "../env.ts";

/** The plugins in this package, by the name the owner ticks. */
export const BUNDLED_PLUGINS: readonly string[] = ["welsh"];

/** The package's own copies: `plugins/<name>`, the same distance from `src/` and `dist/`. */
export const PACKAGE_PLUGINS = fileURLToPath(new URL("../../plugins/", import.meta.url));

/** Left out of a copy and its hash: what a plugin installs for itself, and its own tests. */
const SKIPPED = new Set(["node_modules", "test"]);

/** Where a pod keeps its copies: beside the workspace checkout, on the same disk. */
export function pluginCacheRoot(workspace: string): string {
  return path.join(path.dirname(path.resolve(workspace)), ".agent-hub-plugins");
}

/**
 * The copies of every ticked bundled plugin, made where missing, for a pod's sessions to load. A plugin that cannot
 * be copied is said and left out rather than stopping the pod: its owner's chats still run, without it.
 */
export function installTicked(
  env: Env,
  workspace: string,
  say: (message: string) => void = () => {},
  install: (name: string, workspace: string) => string = installBundled
): string[] {
  const dirs: string[] = [];
  for (const name of tickedBundled(env)) {
    try {
      dirs.push(install(name, workspace));
    } catch (e) {
      say(`plugin ${name}: could not copy it onto this pod: ${(e as Error).message}`);
    }
  }
  return dirs;
}

/** The bundled plugins among AGENT_HUB_PLUGINS, in the order they are named there. */
export function tickedBundled(env: Env): string[] {
  const named = String(env.AGENT_HUB_PLUGINS || "")
    .split(",")
    .map((name) => name.trim());
  return BUNDLED_PLUGINS.filter((name) => named.includes(name)).sort((a, b) => named.indexOf(a) - named.indexOf(b));
}

function files(dir: string, under = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, under), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)))) {
    if (SKIPPED.has(entry.name)) {
      continue;
    }
    const rel = path.join(under, entry.name);
    if (entry.isDirectory()) {
      out.push(...files(dir, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/** A short hash of a plugin's files, paths and contents, which names its copy. */
export function pluginVersion(source: string): string {
  const hash = createHash("sha256");
  for (const rel of files(source)) {
    hash.update(`${rel}\0`);
    hash.update(fs.readFileSync(path.join(source, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** Where this version of a bundled plugin's copy is, whether or not it has been made yet. */
export function bundledPluginDir(name: string, workspace: string, source = path.join(PACKAGE_PLUGINS, name)): string {
  return path.join(pluginCacheRoot(workspace), `${name}-${pluginVersion(source)}`);
}

/**
 * The copy of a bundled plugin a pod runs, made first if this version has none. Copied under a temporary name and
 * renamed into place, so a copy that exists is a whole one even if the pod stopped halfway through making it.
 */
export function installBundled(name: string, workspace: string, source = path.join(PACKAGE_PLUGINS, name)): string {
  const dir = bundledPluginDir(name, workspace, source);
  if (fs.existsSync(dir)) {
    return dir;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const partial = `${dir}.partial-${process.pid}`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.cpSync(source, partial, { recursive: true, filter: (from) => !SKIPPED.has(path.basename(from)) || from === source });
  // A packed package need not keep a script's executable bit, so anything that starts with a shebang gets it back.
  for (const rel of files(partial)) {
    const file = path.join(partial, rel);
    if (fs.readFileSync(file).subarray(0, 2).toString() === "#!") {
      fs.chmodSync(file, 0o755);
    }
  }
  try {
    fs.renameSync(partial, dir);
  } catch (e) {
    // Another process made the same version first; theirs is as good as this one.
    fs.rmSync(partial, { recursive: true, force: true });
    if (!fs.existsSync(dir)) {
      throw e;
    }
  }
  return dir;
}
