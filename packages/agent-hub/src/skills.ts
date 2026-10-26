// The skills this session can run, reported to agent-hub so the web UI can offer them as a "/" autocomplete.
// Every file read here belongs to Claude Code rather than to this client, so each one is narrowed on the way in
// and an unreadable or unexpected shape means "no skills from there" rather than a failed report.
import fs from "node:fs";
import path from "node:path";
import type { Env } from "./env.ts";
import { claudeHome, projectDir, readJson, sha256 } from "./session.ts";

export const MAX_SKILLS = 200;
export const MAX_SKILL_NAME = 100;
export const MAX_SKILL_DESCRIPTION = 300;
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9:_-]*$/;

// What this session can offer. `api.ts` has the wire shape, whose description is optional; everything collected here
// carries one, empty when the frontmatter gave none.
export type SkillListing = {
  name: string;
  description: string;
};

export type PluginInstall = {
  name: string;
  dir: string;
};

export type PluginLookup = {
  project: string;
  home: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

// The top-level scalar keys of a markdown file's YAML frontmatter. Enough for SKILL.md: plain, quoted and
// block-scalar (`>`/`|`) values; nested structures are skipped.
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = String(text).split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {};
  }
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "---") {
      break;
    }
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const key = m[1] as string;
    const value = (m[2] as string).trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (
        i + 1 < lines.length &&
        (/^\s/.test(lines[i + 1] as string) || (lines[i + 1] as string).trim() === "") &&
        (lines[i + 1] as string).trim() !== "---"
      ) {
        block.push((lines[++i] as string).trim());
      }
      out[key] = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
    } else if (value) {
      let joined = value;
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] as string)) {
        joined += ` ${(lines[++i] as string).trim()}`;
      }
      out[key] = unquote(joined);
    }
  }
  return out;
}

const isFalse = (v: string | undefined) => String(v).trim().toLowerCase() === "false";
const isTrue = (v: string | undefined) => String(v).trim().toLowerCase() === "true";

// Null for a skill a message cannot run: one hidden from the user, or one the model may not invoke, which is how
// an agent runs a skill named in a message.
export function skillFrom(file: string, fallbackName: string, prefix = ""): SkillListing | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  if (isFalse(fm["user-invocable"]) || isTrue(fm["disable-model-invocation"])) {
    return null;
  }
  const base = String(fm.name || fallbackName).trim();
  const name = `${prefix}${base}`;
  if (name.length > MAX_SKILL_NAME || !SKILL_NAME_RE.test(name)) {
    return null;
  }
  const description = String(fm.description || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SKILL_DESCRIPTION);
  return { name, description };
}

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// `<dir>/skills/*/SKILL.md` and `<dir>/commands/*.md`: Claude Code offers both as slash commands.
function skillsIn(dir: string, prefix = ""): SkillListing[] {
  const found: SkillListing[] = [];
  for (const e of entries(path.join(dir, "skills"))) {
    if (!e.isDirectory() && !e.isSymbolicLink()) {
      continue;
    }
    const skill = skillFrom(path.join(dir, "skills", e.name, "SKILL.md"), e.name, prefix);
    if (skill) {
      found.push(skill);
    }
  }
  for (const e of entries(path.join(dir, "commands"))) {
    if (!e.name.endsWith(".md") || e.isDirectory()) {
      continue;
    }
    const skill = skillFrom(path.join(dir, "commands", e.name), e.name.slice(0, -3), prefix);
    if (skill) {
      found.push(skill);
    }
  }
  return found;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

// Later settings files override earlier ones, as Claude Code layers user, project and local settings.
export function enabledPlugins({ project, home }: PluginLookup): string[] {
  const enabled = new Map<string, boolean>();
  for (const file of [path.join(home, "settings.json"), path.join(project, ".claude", "settings.json"), path.join(project, ".claude", "settings.local.json")]) {
    const plugins = asRecord(asRecord(readJson(file))?.enabledPlugins);
    if (!plugins) {
      continue;
    }
    for (const [key, on] of Object.entries(plugins)) {
      enabled.set(key, on === true);
    }
  }
  return [...enabled].filter(([, on]) => on).map(([key]) => key);
}

function pluginName(dir: string, fallback: string): string {
  const name = asRecord(readJson(path.join(dir, ".claude-plugin", "plugin.json")))?.name;
  return typeof name === "string" && name ? name : fallback;
}

// The plugins a virtual agent's owner ticked, which hai loads with --plugin-dir: each name in
// AGENT_HUB_PLUGINS resolved through this checkout's marketplace.json. A name hai skips is skipped here too.
export function hubPlugins({ project, env = process.env }: { project: string; env?: Env }): PluginInstall[] {
  const names = String(env.AGENT_HUB_PLUGINS || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names.length) {
    return [];
  }
  const listed = asRecord(readJson(path.join(project, ".claude-plugin", "marketplace.json")))?.plugins;
  if (!Array.isArray(listed)) {
    return [];
  }
  const out: PluginInstall[] = [];
  for (const name of names) {
    const source = listed.map(asRecord).find((p) => p?.name === name)?.source;
    if (typeof source !== "string" || !source) {
      continue;
    }
    const dir = path.resolve(project, source);
    if (!fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) {
      continue;
    }
    out.push({ name: pluginName(dir, name), dir });
  }
  return out;
}

// Where an enabled plugin is installed, from installed_plugins.json: a user-scope install, or a project- or
// local-scope one for this project. A plugin enabled but not installed has no skills to offer. Then the
// AGENT_HUB_PLUGINS ones not already found that way.
export function pluginInstalls({ project, home, env = process.env }: PluginLookup & { env?: Env }): PluginInstall[] {
  const installed = asRecord(asRecord(readJson(path.join(home, "plugins", "installed_plugins.json")))?.plugins);
  const out: PluginInstall[] = [];
  if (installed) {
    for (const key of enabledPlugins({ project, home })) {
      const list = (Array.isArray(installed[key]) ? (installed[key] as unknown[]) : []).map(asRecord);
      const entry =
        list.find((e) => e?.scope === "user" && typeof e.installPath === "string" && e.installPath) ||
        list.find((e) => typeof e?.installPath === "string" && e.installPath && typeof e.projectPath === "string" && samePath(e.projectPath, project));
      const installPath = typeof entry?.installPath === "string" ? entry.installPath : null;
      if (!installPath || !fs.existsSync(installPath)) {
        continue;
      }
      out.push({ name: pluginName(installPath, key.split("@")[0] as string), dir: installPath });
    }
  }
  for (const plugin of hubPlugins({ project, env })) {
    if (!out.some((p) => p.name === plugin.name || samePath(p.dir, plugin.dir))) {
      out.push(plugin);
    }
  }
  return out;
}

export type CollectSkillsOptions = {
  project?: string;
  home?: string;
  env?: Env;
};

// User skills win over project ones of the same name, as in Claude Code; plugin skills are namespaced so never clash.
export function collectSkills({ project = projectDir(), home = claudeHome(), env = process.env }: CollectSkillsOptions = {}): SkillListing[] {
  const all = [...skillsIn(home), ...skillsIn(path.join(project, ".claude"))];
  for (const plugin of pluginInstalls({ project, home, env })) {
    all.push(...skillsIn(plugin.dir, `${plugin.name}:`));
  }
  const seen = new Set<string>();
  const skills: SkillListing[] = [];
  for (const skill of all) {
    if (seen.has(skill.name)) {
      continue;
    }
    seen.add(skill.name);
    skills.push(skill);
  }
  return skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, MAX_SKILLS);
}

export function skillsHash(skills: SkillListing[]): string {
  return sha256(JSON.stringify(skills));
}
