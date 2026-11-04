import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON_PLUGINS,
  BUNDLED_DIRS_VAR,
  BUNDLED_PLUGINS,
  bundledDirsOf,
  bundledPluginDir,
  installBundled,
  installLoaded,
  isAlwaysOn,
  loadedBundled,
  PACKAGE_PLUGINS,
  pluginCacheRoot,
  pluginVersion,
  SLIDES_PLUGIN,
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
  it.each(["welsh", "slides"])("should carry the %s plugin in the package itself", (name) => {
    expect(BUNDLED_PLUGINS).toContain(name);
    expect(fs.existsSync(path.join(PACKAGE_PLUGINS, name, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(PACKAGE_PLUGINS, name, "scripts", name))).toBe(true);
  });

  it("should list every plugin it carries in the repository's marketplace, for anyone to install", () => {
    const marketplace = JSON.parse(fs.readFileSync(path.join(PACKAGE_PLUGINS, "..", "..", "..", ".claude-plugin", "marketplace.json"), "utf8"));
    expect(marketplace.plugins.map((plugin: { name: string; source: string }) => [plugin.name, plugin.source])).toEqual(
      BUNDLED_PLUGINS.map((name) => [name, `./packages/agent-hub/plugins/${name}`])
    );
  });

  it("should pick out only the ticked names this package carries", () => {
    expect(tickedBundled({ AGENT_HUB_PLUGINS: "pcs, welsh ,dtsse" })).toEqual(["welsh"]);
    expect(tickedBundled({ AGENT_HUB_PLUGINS: "pcs" })).toEqual([]);
    expect(tickedBundled({})).toEqual([]);
  });

  it("should load slides whether or not it is ticked", () => {
    expect(ALWAYS_ON_PLUGINS).toEqual([SLIDES_PLUGIN]);
    expect(isAlwaysOn("slides")).toBe(true);
    expect(isAlwaysOn("welsh")).toBe(false);
    expect(loadedBundled({})).toEqual(["slides"]);
    expect(loadedBundled({ AGENT_HUB_PLUGINS: "pcs" })).toEqual(["slides"]);
  });

  it("should load welsh only when it is ticked, and slides once when it is ticked too", () => {
    expect(loadedBundled({ AGENT_HUB_PLUGINS: "pcs,welsh" })).toEqual(["slides", "welsh"]);
    expect(loadedBundled({ AGENT_HUB_PLUGINS: "slides,welsh" })).toEqual(["slides", "welsh"]);
    expect(loadedBundled({ AGENT_HUB_PLUGINS: "slides" })).toEqual(["slides"]);
  });

  it("should copy slides onto the pod when nothing is ticked", () => {
    const copied: string[] = [];
    const dirs = installLoaded({}, "/workspace/cft-workspace", undefined, (name) => {
      copied.push(name);
      return `/copies/${name}`;
    });
    expect(copied).toEqual(["slides"]);
    expect(dirs).toEqual(["/copies/slides"]);
  });

  it("should keep the copies beside the workspace, on the same disk", () => {
    expect(pluginCacheRoot("/workspace/cft-workspace")).toBe("/workspace/.agent-hub-plugins");
  });

  it("should version a plugin by its files, ignoring its tests, installed dependencies and install lock", () => {
    const other = source();
    fs.writeFileSync(path.join(other, "scripts", "lib", "test", "a.test.ts"), "changed");
    fs.writeFileSync(path.join(other, "scripts", "lib", "node_modules", "dep", "index.js"), "changed");
    fs.writeFileSync(path.join(other, "scripts", "lib", ".install.lock"), "");
    expect(pluginVersion(other)).toBe(pluginVersion(source()));
    expect(pluginVersion(source("#!/bin/sh\necho changed\n"))).not.toBe(pluginVersion(source()));
  });

  it("should work a source's version out once, since the package does not change under a running process", () => {
    const src = source();
    const before = pluginVersion(src);
    fs.writeFileSync(path.join(src, "scripts", "welsh"), "#!/bin/sh\necho changed\n");
    expect(pluginVersion(src)).toBe(before);
  });

  it("should name the copies a session was started with, and none when it was given none", () => {
    expect(bundledDirsOf({ [BUNDLED_DIRS_VAR]: ["/a/welsh-1", "/b/x-2"].join(path.delimiter) })).toEqual(["/a/welsh-1", "/b/x-2"]);
    expect(bundledDirsOf({})).toEqual([]);
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

  it("should make a new copy when the plugin changes, and remove the old one and a half-made copy whose process has gone", () => {
    // Arrange
    const ws = workspace();
    const first = installBundled("welsh", ws, source());
    const stale = path.join(pluginCacheRoot(ws), "welsh-0123456789ab.partial-2147483646");
    const live = path.join(pluginCacheRoot(ws), `welsh-0123456789ab.partial-${process.pid}`);
    const unrelated = path.join(pluginCacheRoot(ws), "welsh-notes");
    fs.mkdirSync(stale);
    fs.mkdirSync(live);
    fs.mkdirSync(unrelated);

    // Act
    const second = installBundled("welsh", ws, source("#!/bin/sh\necho v2\n"));

    // Assert
    expect(second).not.toBe(first);
    expect(fs.readFileSync(path.join(second, "scripts", "welsh"), "utf8")).toBe("#!/bin/sh\necho v2\n");
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("should say and leave out a plugin it cannot copy, rather than stop", () => {
    const said: string[] = [];
    const dirs = installLoaded(
      { AGENT_HUB_PLUGINS: "welsh" },
      "/workspace/cft-workspace",
      (m) => said.push(m),
      (name) => {
        if (name === "welsh") {
          throw new Error("ENOSPC");
        }
        return `/copies/${name}`;
      }
    );
    expect(dirs).toEqual(["/copies/slides"]);
    expect(said).toEqual(["plugin welsh: could not copy it onto this pod: ENOSPC"]);
  });
});

describe("the bundled plugins' scripts", () => {
  /** A plugin's wrapper from `set -euo pipefail` on, its own name made generic: its install, lock and marker logic. */
  const logicOf = (name: string): string => {
    const script = fs.readFileSync(path.join(PACKAGE_PLUGINS, name, "scripts", name), "utf8");
    const start = script.indexOf("set -euo pipefail");
    expect(start, `${name}'s wrapper sets -euo pipefail`).toBeGreaterThan(-1);
    return script.slice(start).replaceAll(name, "<plugin>");
  };

  it("should install, lock and mark done the same way in every plugin's wrapper", () => {
    // Each plugin carries its own copy, since it is installed and copied to pods by itself, so the copies are kept in step here.
    const [first, ...rest] = BUNDLED_PLUGINS;
    for (const name of rest) {
      expect(logicOf(name), `scripts/${name} against scripts/${first}`).toBe(logicOf(first as string));
    }
  });
});
