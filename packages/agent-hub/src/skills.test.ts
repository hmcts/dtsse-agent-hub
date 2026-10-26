// What a session reports as its "/" autocomplete: SKILL.md frontmatter, slash commands, and the plugins Claude
// Code has installed and enabled. The workspace suite's last case asserted that `registerAgent` sends the list
// and stores its hash; it is in `agent.test.ts`, beside the module it belongs to.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import { collectSkills, enabledPlugins, hubPlugins, parseFrontmatter, pluginInstalls, skillFrom, skillsHash } from "./skills.ts";

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};
const cleanups: (() => void)[] = [];

beforeAll(() => {
  home = tempClaudeHome();
  for (const [key, value] of Object.entries(home.env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  home.cleanup();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function skill(dir: string, name: string, frontmatter: string) {
  write(path.join(dir, "skills", name, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n`);
}

type Layout = {
  project: string;
  home: string;
  root: string;
};

// A project and a Claude config directory of their own, so each test sees only what it wrote.
function layout(): Layout {
  const root = fs.mkdtempSync(path.join(home.root, "skills-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const config = path.join(root, "config");
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  return { project, home: config, root };
}

type InstalledPlugin = {
  name?: string;
  scope?: string;
  projectPath?: string;
  skills?: [string, string][];
};

function installPlugin(l: Layout, key: string, { name, scope = "user", projectPath, skills: list = [] }: InstalledPlugin) {
  const dir = path.join(l.home, "plugins", "cache", key.replace("@", "-"));
  if (name) {
    write(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  }
  for (const [skillName, fm] of list) {
    skill(dir, skillName, fm);
  }
  const file = path.join(l.home, "plugins", "installed_plugins.json");
  const installed = (readPluginFile(file) ?? { version: 2, plugins: {} }) as { version: number; plugins: Record<string, unknown[]> };
  installed.plugins[key] = [...(installed.plugins[key] ?? []), { scope, installPath: dir, ...(projectPath ? { projectPath } : {}) }];
  write(file, JSON.stringify(installed));
}

function readPluginFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// A workspace plugin in the project's marketplace.json, as hai loads it with --plugin-dir.
function marketplacePlugin(l: Layout, name: string, { manifest = true, skills: list = [] }: { manifest?: boolean; skills?: [string, string][] } = {}) {
  const dir = path.join(l.project, "apps", name, ".claude");
  if (manifest) {
    write(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
  }
  for (const [skillName, fm] of list) {
    skill(dir, skillName, fm);
  }
  const file = path.join(l.project, ".claude-plugin", "marketplace.json");
  const marketplace = (readPluginFile(file) ?? { name: "cft-workspace", plugins: [] }) as { name: string; plugins: unknown[] };
  marketplace.plugins.push({ name, source: `./apps/${name}/.claude` });
  write(file, JSON.stringify(marketplace));
}

describe("parseFrontmatter", () => {
  it("should read plain, quoted and folded values and ignore the body when a SKILL.md is parsed", () => {
    // Act
    const fm = parseFrontmatter(
      [
        "---",
        "name: cft-explain",
        'description: "Answer \\"what is X\\""',
        "other: 'it''s'",
        "long: >",
        "  first line",
        "  second line",
        "list:",
        "  - a",
        "---",
        "name: body"
      ].join("\n")
    );

    // Assert
    expect(fm.name).toBe("cft-explain");
    expect(fm.description).toBe('Answer "what is X"');
    expect(fm.other).toBe("it's");
    expect(fm.long).toBe("first line second line");
  });

  it("should be empty when the file has no frontmatter", () => {
    // Act & Assert
    expect(parseFrontmatter("# no frontmatter\nname: x")).toEqual({});
  });

  it("should keep the line breaks of a literal block when the value opens with a pipe", () => {
    // Act
    const fm = parseFrontmatter(["---", "notes: |", "  one", "  two", "---"].join("\n"));

    // Assert
    expect(fm.notes).toBe("one\ntwo");
  });
});

describe("skillFrom", () => {
  it("should be null when the file cannot be read", () => {
    // Act & Assert
    expect(skillFrom(path.join(home.root, "no-such-skill", "SKILL.md"), "missing")).toBeNull();
  });
});

describe("collectSkills", () => {
  it("should find project and user skills and commands and skip those a message cannot run when both trees hold skills", () => {
    // Arrange
    const l = layout();
    const projectClaude = path.join(l.project, ".claude");
    skill(projectClaude, "cft-explain", "name: cft-explain\ndescription: Explain a\n  CFT topic");
    skill(projectClaude, "enable-comms", "name: enable-comms\ndescription: x\ndisable-model-invocation: true");
    skill(projectClaude, "hidden", "name: hidden\ndescription: x\nuser-invocable: false");
    skill(projectClaude, "Bad Name", "description: no name, and the directory is not a valid one");
    skill(projectClaude, "shared", "name: shared\ndescription: the project one");
    skill(projectClaude, "long", `name: long\ndescription: ${"d".repeat(400)}`);
    write(path.join(projectClaude, "commands", "repo-sync.md"), "---\ndescription: Fast-forward the clones\n---\nRun it.\n");
    skill(l.home, "shared", "name: shared\ndescription: the user one");
    skill(l.home, "solirius-invoice", "description: Populate the invoice");

    // Act
    const skills = collectSkills({ project: l.project, home: l.home });

    // Assert
    expect(skills.map((s) => s.name)).toEqual(["cft-explain", "long", "repo-sync", "shared", "solirius-invoice"]);
    expect(skills.find((s) => s.name === "cft-explain")?.description).toBe("Explain a CFT topic");
    expect(skills.find((s) => s.name === "shared")?.description).toBe("the user one");
    expect(skills.find((s) => s.name === "long")?.description).toHaveLength(300);
    expect(skills.find((s) => s.name === "repo-sync")?.description).toBe("Fast-forward the clones");
  });

  it("should namespace the skills of installed, enabled plugins and leave out the rest when settings layer", () => {
    // Arrange
    const l = layout();
    write(path.join(l.home, "settings.json"), JSON.stringify({ enabledPlugins: { "pcs@cft-workspace": true, "off@m": true, "missing@m": true } }));
    write(path.join(l.project, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "chat@cft-workspace": true, "elsewhere@m": true } }));
    write(path.join(l.project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "off@m": false } }));
    installPlugin(l, "pcs@cft-workspace", { name: "pcs", skills: [["start-env", "name: start-env\ndescription: Start an environment"]] });
    installPlugin(l, "chat@cft-workspace", { scope: "project", projectPath: l.project, skills: [["hub", "name: hub\ndescription: Open the pane"]] });
    installPlugin(l, "elsewhere@m", { scope: "project", projectPath: path.join(l.root, "other"), skills: [["x", "name: x\ndescription: x"]] });
    installPlugin(l, "off@m", { name: "off", skills: [["y", "name: y\ndescription: y"]] });
    installPlugin(l, "unenabled@m", { name: "unenabled", skills: [["z", "name: z\ndescription: z"]] });

    // Act & Assert
    expect(enabledPlugins({ project: l.project, home: l.home }).sort((a, b) => a.localeCompare(b))).toEqual([
      "chat@cft-workspace",
      "elsewhere@m",
      "missing@m",
      "pcs@cft-workspace"
    ]);
    expect(collectSkills({ project: l.project, home: l.home })).toEqual([
      { name: "chat:hub", description: "Open the pane" },
      { name: "pcs:start-env", description: "Start an environment" }
    ]);
  });

  it("should namespace the skills of the plugins AGENT_HUB_PLUGINS names once each when a marketplace lists them", () => {
    // Arrange
    const l = layout();
    marketplacePlugin(l, "pcs", { skills: [["start-env", "name: start-env\ndescription: Start an environment"]] });
    marketplacePlugin(l, "dtsse", { skills: [["wip-add", "name: wip-add\ndescription: Write up WIP"]] });
    marketplacePlugin(l, "nomanifest", { manifest: false, skills: [["x", "name: x\ndescription: x"]] });
    marketplacePlugin(l, "unticked", { skills: [["y", "name: y\ndescription: y"]] });
    write(path.join(l.home, "settings.json"), JSON.stringify({ enabledPlugins: { "pcs@cft-workspace": true } }));
    installPlugin(l, "pcs@cft-workspace", { name: "pcs", skills: [["start-env", "name: start-env\ndescription: Installed copy"]] });
    const env = { AGENT_HUB_PLUGINS: " pcs, dtsse,bogus,nomanifest,," };

    // Act & Assert
    expect(pluginInstalls({ project: l.project, home: l.home, env }).map((p) => p.name)).toEqual(["pcs", "dtsse"]);
    expect(collectSkills({ project: l.project, home: l.home, env })).toEqual([
      { name: "dtsse:wip-add", description: "Write up WIP" },
      { name: "pcs:start-env", description: "Installed copy" }
    ]);
    expect(collectSkills({ project: l.project, home: l.home, env: {} })).toEqual([{ name: "pcs:start-env", description: "Installed copy" }]);
  });

  it("should report at most 200 skills when the tree holds more", () => {
    // Arrange
    const l = layout();
    for (let i = 0; i < 205; i++) {
      skill(l.home, `s${String(i).padStart(3, "0")}`, `description: ${i}`);
    }

    // Act
    const skills = collectSkills({ project: l.project, home: l.home });

    // Assert
    expect(skills).toHaveLength(200);
    expect(skills[199]?.name).toBe("s199");
  });

  it("should read the user skills from CLAUDE_CONFIG_DIR when no home is given", () => {
    // Arrange
    const l = layout();
    skill(home.claude, "from-config-dir", "description: here");
    cleanups.push(() => fs.rmSync(path.join(home.claude, "skills"), { recursive: true, force: true }));

    // Act & Assert
    expect(collectSkills({ project: l.project })).toEqual([{ name: "from-config-dir", description: "here" }]);
  });
});

describe("enabledPlugins", () => {
  it("should ignore a settings file that is unreadable or whose enabledPlugins is not an object", () => {
    // Arrange
    const l = layout();
    write(path.join(l.home, "settings.json"), "{not json");
    write(path.join(l.project, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: ["a@m"] }));
    write(path.join(l.project, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "real@m": true } }));

    // Act & Assert
    expect(enabledPlugins({ project: l.project, home: l.home })).toEqual(["real@m"]);
  });
});

describe("hubPlugins", () => {
  it("should be empty when AGENT_HUB_PLUGINS is unset or the marketplace cannot be read", () => {
    // Arrange
    const l = layout();

    // Act & Assert
    expect(hubPlugins({ project: l.project, env: {} })).toEqual([]);
    expect(hubPlugins({ project: l.project, env: { AGENT_HUB_PLUGINS: "pcs" } })).toEqual([]);
    write(path.join(l.project, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: "not a list" }));
    expect(hubPlugins({ project: l.project, env: { AGENT_HUB_PLUGINS: "pcs" } })).toEqual([]);
  });

  it("should skip an entry whose source is missing when the marketplace is malformed", () => {
    // Arrange
    const l = layout();
    write(path.join(l.project, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: [{ name: "pcs" }, "not an object"] }));

    // Act & Assert
    expect(hubPlugins({ project: l.project, env: { AGENT_HUB_PLUGINS: "pcs" } })).toEqual([]);
  });
});

describe("pluginInstalls", () => {
  it("should be empty when installed_plugins.json cannot be read", () => {
    // Arrange
    const l = layout();
    write(path.join(l.home, "settings.json"), JSON.stringify({ enabledPlugins: { "pcs@m": true } }));
    write(path.join(l.home, "plugins", "installed_plugins.json"), "{not json");

    // Act & Assert
    expect(pluginInstalls({ project: l.project, home: l.home, env: {} })).toEqual([]);
  });

  it("should fall back to the key when the installed plugin has no manifest name", () => {
    // Arrange
    const l = layout();
    write(path.join(l.home, "settings.json"), JSON.stringify({ enabledPlugins: { "nameless@m": true } }));
    installPlugin(l, "nameless@m", { skills: [["a", "name: a\ndescription: a"]] });

    // Act & Assert
    expect(pluginInstalls({ project: l.project, home: l.home, env: {} }).map((p) => p.name)).toEqual(["nameless"]);
  });
});

describe("skillsHash", () => {
  it("should change when the list changes and match for the same list", () => {
    // Arrange
    const skills = [{ name: "cft-explain", description: "Explain" }];

    // Act & Assert
    expect(skillsHash(skills)).toBe(skillsHash([{ name: "cft-explain", description: "Explain" }]));
    expect(skillsHash(skills)).not.toBe(skillsHash([{ name: "cft-explain", description: "Explain it" }]));
    expect(skillsHash(skills)).toMatch(/^[0-9a-f]{64}$/);
  });
});
