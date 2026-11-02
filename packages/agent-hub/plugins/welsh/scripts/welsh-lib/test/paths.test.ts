import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findWorkspace, workspaceAbove } from "../paths.ts";

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "welsh-ws-")));
  writeFileSync(join(dir, "workspace.yaml"), "repos: []\n");
  mkdirSync(join(dir, "apps", "cath", "welsh"), { recursive: true });
  return dir;
}

test("workspaceAbove finds the workspace from a directory inside it", () => {
  const ws = workspace();
  assert.equal(workspaceAbove(join(ws, "apps", "cath", "welsh")), ws);
});

test("workspaceAbove gives null outside any workspace", () => {
  assert.equal(workspaceAbove(realpathSync(mkdtempSync(join(tmpdir(), "welsh-none-")))), null);
});

test("findWorkspace prefers CFT_WELSH_WORKSPACE over everything else", () => {
  const ws = workspace();
  assert.equal(findWorkspace({ CFT_WELSH_WORKSPACE: ws, CLAUDE_PROJECT_DIR: workspace() }, workspace()), ws);
});

test("findWorkspace uses Claude Code's project directory before the working directory", () => {
  const project = workspace();
  assert.equal(findWorkspace({ CLAUDE_PROJECT_DIR: join(project, "apps") }, workspace()), project);
});

test("findWorkspace falls back to the working directory", () => {
  const ws = workspace();
  assert.equal(findWorkspace({}, join(ws, "apps", "cath")), ws);
});
