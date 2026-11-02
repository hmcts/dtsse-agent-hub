import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_PLUGINS,
  bundledPluginDir,
  installBundled,
  installTicked,
  PACKAGE_PLUGINS,
  pluginCacheRoot,
  pluginVersion,
  tickedBundled
} from "./bundled-plugins.ts";

/** A plugin source with a script, a test and an installed dependency, the last two of which a copy leaves out. */
function source(script = "#!/bin/sh\necho hi\n"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-src-"));
  fs.mkdirSync(path.join(dir, ".claude-plugin"));
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "welsh" }));
  fs.mkdirSync(path.join(dir, "scripts", "lib", "test"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts", "lib", "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "welsh"), script);
  fs.writeFileSync(path.join(dir, "scripts", "lib", "test", "a.test.ts"), "test");
  fs.writeFileSync(path.join(dir, "scripts", "lib", "node_modules", "dep", "index.js"), "dep");
  return dir;
}

function workspace(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bundled-pvc-")), "cft-workspace");
}

describe("bundled plugins", () => {
  it("should carry the welsh plugin in the package itself", () => {
    expect(BUNDLED_PLUGINS).toEqual(["welsh"]);
    expect(fs.existsSync(path.join(PACKAGE_PLUGINS, "welsh", ".claude-plugin", "plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(PACKAGE_PLUGINS, "welsh", "scripts", "welsh"))).toBe(true);
  });

  it("should pick out only the ticked names this package carries", () => {
    expect(tickedBundled({ AGENT_HUB_PLUGINS: "pcs, welsh ,dtsse" })).toEqual(["welsh"]);
    expect(tickedBundled({ AGENT_HUB_PLUGINS: "pcs" })).toEqual([]);
    expect(tickedBundled({})).toEqual([]);
  });

  it("should keep the copies beside the workspace, on the same disk", () => {
    expect(pluginCacheRoot("/workspace/cft-workspace")).toBe("/workspace/.agent-hub-plugins");
  });

  it("should version a plugin by its files, ignoring its tests and installed dependencies", () => {
    const src = source();
    const before = pluginVersion(src);
    fs.writeFileSync(path.join(src, "scripts", "lib", "test", "a.test.ts"), "changed");
    fs.writeFileSync(path.join(src, "scripts", "lib", "node_modules", "dep", "index.js"), "changed");
    expect(pluginVersion(src)).toBe(before);
    fs.writeFileSync(path.join(src, "scripts", "welsh"), "#!/bin/sh\necho changed\n");
    expect(pluginVersion(src)).not.toBe(before);
  });

  it("should copy a plugin once per version, without its tests or dependencies, and reuse the copy", () => {
    // Arrange
    const src = source();
    const ws = workspace();

    // Act
    const dir = installBundled("welsh", ws, src);
    fs.writeFileSync(path.join(dir, "scripts", "installed-later"), "kept");
    const again = installBundled("welsh", ws, src);

    // Assert
    expect(dir).toBe(bundledPluginDir("welsh", ws, src));
    expect(path.dirname(dir)).toBe(pluginCacheRoot(ws));
    expect(fs.readFileSync(path.join(dir, "scripts", "welsh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(fs.statSync(path.join(dir, "scripts", "welsh")).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(dir, "scripts", "lib", "test"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "scripts", "lib", "node_modules"))).toBe(false);
    expect(again).toBe(dir);
    expect(fs.existsSync(path.join(again, "scripts", "installed-later"))).toBe(true);
  });

  it("should make a new copy when the plugin changes", () => {
    const ws = workspace();
    const first = installBundled("welsh", ws, source());
    const second = installBundled("welsh", ws, source("#!/bin/sh\necho v2\n"));
    expect(second).not.toBe(first);
    expect(fs.readFileSync(path.join(second, "scripts", "welsh"), "utf8")).toBe("#!/bin/sh\necho v2\n");
  });

  it("should say and leave out a ticked plugin it cannot copy, rather than stop", () => {
    const said: string[] = [];
    const dirs = installTicked(
      { AGENT_HUB_PLUGINS: "welsh" },
      "/workspace/cft-workspace",
      (m) => said.push(m),
      () => {
        throw new Error("ENOSPC");
      }
    );
    expect(dirs).toEqual([]);
    expect(said).toEqual(["plugin welsh: could not copy it onto this pod: ENOSPC"]);
  });
});
