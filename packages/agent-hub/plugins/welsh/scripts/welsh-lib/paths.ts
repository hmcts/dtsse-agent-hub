import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The nearest directory at or above `start` holding a `workspace.yaml`, or null. */
export function workspaceAbove(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "workspace.yaml"))) {
      return dir;
    }
    if (dirname(dir) === dir) {
      return null;
    }
  }
}

/**
 * The cft-workspace whose catalogues and clones this works on. The override comes first: a virtual agent's pod sets
 * it, since it runs the plugin from a copy outside the workspace, and tests and `import --pr`'s worktree point it at
 * a scratch tree. Then Claude Code's project directory, then the directory it was run from, then where this file
 * sits, which is right only when the plugin is read from a dtsse-agent-hub clone inside the workspace.
 */
export function findWorkspace(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.CFT_WELSH_WORKSPACE) {
    return resolve(env.CFT_WELSH_WORKSPACE);
  }
  const found =
    (env.CLAUDE_PROJECT_DIR ? workspaceAbove(env.CLAUDE_PROJECT_DIR) : null) ?? workspaceAbove(cwd) ?? workspaceAbove(dirname(fileURLToPath(import.meta.url)));
  if (!found) {
    throw new Error("not inside a cft-workspace checkout (no workspace.yaml above here); run it from the workspace or set CFT_WELSH_WORKSPACE");
  }
  return found;
}

export const WORKSPACE = findWorkspace();
