import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findTool, tool } from "../tools.ts";

test("a tool is found by its full path in PATH's absolute directories only", () => {
  const here = realpathSync(mkdtempSync(join(tmpdir(), "welsh-tools-")));
  for (const dir of ["rel", "abs"]) {
    mkdirSync(join(here, dir));
    writeFileSync(join(here, dir, "welsh-fake-tool"), "#!/bin/sh\n", { mode: 0o755 });
  }
  const path = process.env.PATH;
  const cwd = process.cwd();
  process.chdir(here);
  process.env.PATH = ["rel", join(here, "abs")].join(":");
  try {
    assert.equal(findTool("welsh-fake-tool"), join(here, "abs", "welsh-fake-tool"));
    assert.equal(findTool("welsh-not-there"), null);
    assert.throws(() => tool("welsh-not-there"), /welsh-not-there is not installed, or not on PATH/);
  } finally {
    process.env.PATH = path;
    process.chdir(cwd);
  }
});
