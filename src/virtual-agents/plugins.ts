import { byCodePoint } from "../topics/slug.ts";
import type { Environment } from "./settings.ts";

/**
 * The workspace plugins a virtual agent's pod can load, from the workspace marketplace (`.claude-plugin/
 * marketplace.json` in the checkout). Which ones are offered is hub configuration, `VIRTUAL_AGENT_PLUGINS`; the
 * owner ticks any of them, and the orchestrator passes the ticked names to the pod as `AGENT_HUB_PLUGINS`. The pod
 * skips a name its checkout does not have, so a name dropped from the configuration does no harm on a pod that keeps
 * it.
 */

export const MAX_PLUGINS = 20;

/** A marketplace plugin name: lowercase letters, digits and hyphens, starting with a letter or digit. */
export const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PluginOption {
  name: string;
  /** Empty when the configuration gives none. */
  description: string;
}

export class PluginConfigurationError extends Error {}

/**
 * `VIRTUAL_AGENT_PLUGINS`, a comma-separated list of `name` or `name=description`, as `pcs=PCS team workflows,dtsse`,
 * in the order given. A name repeated keeps its first entry. Read per call, as the other virtual-agent settings are.
 */
export function availablePlugins(env: Environment = process.env): PluginOption[] {
  const options: PluginOption[] = [];
  for (const entry of (env.VIRTUAL_AGENT_PLUGINS ?? "").split(",")) {
    if (entry.trim() === "") {
      continue;
    }
    const split = entry.indexOf("=");
    const name = (split === -1 ? entry : entry.slice(0, split)).trim();
    const description = split === -1 ? "" : entry.slice(split + 1).trim();
    if (!PLUGIN_NAME.test(name)) {
      throw new PluginConfigurationError(`VIRTUAL_AGENT_PLUGINS has ${JSON.stringify(name)}, which is not a plugin name`);
    }
    if (!options.some((option) => option.name === name)) {
      options.push({ name, description });
    }
  }
  return options;
}

export type CheckedPlugins = { ok: true; plugins: string[] } | { ok: false; error: string };

/**
 * A form that sends none ticks none. Otherwise each value has to be one of `allowed`, and what is kept is the
 * distinct names in code-point order, so the same set is always stored, and passed to the pod, the same way.
 */
export function checkPlugins(raw: unknown, allowed: readonly string[]): CheckedPlugins {
  if (raw === undefined || raw === null) {
    return { ok: true, plugins: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "plugins are a list of names" };
  }
  const names = new Set<string>();
  for (const value of raw) {
    const name = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!PLUGIN_NAME.test(name)) {
      return { ok: false, error: "a plugin name is lowercase letters, digits and hyphens" };
    }
    if (!allowed.includes(name)) {
      return { ok: false, error: `${name} is not a plugin this hub offers` };
    }
    names.add(name);
  }
  if (names.size > MAX_PLUGINS) {
    return { ok: false, error: `a virtual agent has at most ${MAX_PLUGINS} plugins` };
  }
  return { ok: true, plugins: [...names].sort(byCodePoint) };
}

export function samePlugins(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** What is stored, which the database only checks is an array, as the names in it. */
export function storedPlugins(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}
