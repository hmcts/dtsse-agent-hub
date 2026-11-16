import { byCodePoint } from "../topics/slug.ts";
import type { Environment } from "./settings.ts";

/**
 * The plugins a virtual agent's pod can load: those of the workspace marketplace (`.claude-plugin/marketplace.json` in
 * the checkout), and those the pod client carries in `packages/agent-hub/plugins/`, which the pod copies onto its
 * own disk. Which ones are offered is hub configuration, `VIRTUAL_AGENT_PLUGINS`; the
 * owner ticks any of them, and the orchestrator passes the ticked names to the pod as `AGENT_HUB_PLUGINS`. The pod
 * skips a name its checkout does not have, so a name dropped from the configuration does no harm on a pod that keeps
 * it.
 */

/** The plugin that carries the slides tools, which a deck build needs on the pod. */
export const SLIDES_PLUGIN = "slides";

/**
 * The plugins every pod loads without being ticked, mirroring the pod client's own `ALWAYS_ON_PLUGINS`
 * (`packages/agent-hub/src/virtual/bundled-plugins.ts`). Slides is one because the Assistant's slides panel, history,
 * editing and builds depend on it, and the Microsoft 365 plugins because pressing Connect for Microsoft 365 is their
 * opt-in, so there is nothing to tick. None is offered or stored; every claim adds them to the plugins it hands the
 * orchestrator (`podPlugins`), so a pod on a client that loads only what `AGENT_HUB_PLUGINS` names loads them too.
 */
export const ALWAYS_ON_PLUGINS: readonly string[] = [SLIDES_PLUGIN, "m365", "m365-files"];

export const isAlwaysOn = (name: string): boolean => ALWAYS_ON_PLUGINS.includes(name);

export const MAX_PLUGINS = 20;

/** A marketplace plugin name: lowercase letters, digits and hyphens, starting with a letter or digit. */
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PluginOption {
  name: string;
  /** Empty when the configuration gives none. */
  description: string;
}

export class PluginConfigurationError extends Error {}

/**
 * What a plugin form is given: the options `VIRTUAL_AGENT_PLUGINS` offers, or why it could not be read. The two are
 * separate states because they call for different things from whoever is looking: an empty offer is a hub that has no
 * plugins to give, and a form that cannot read the configuration has to say so rather than pass itself off as one.
 */
export type PluginOffer = { ok: true; available: readonly PluginOption[] } | { ok: false; error: string };

/** An offer of no plugins, which is what an unset `VIRTUAL_AGENT_PLUGINS` gives. */
export const NO_PLUGINS: PluginOffer = { ok: true, available: [] };

/**
 * `VIRTUAL_AGENT_PLUGINS`, a comma-separated list of `name` or `name=description`, as `pcs=PCS team workflows,dtsse`,
 * in the order given. A name repeated keeps its first entry, and an always-on one is left out, since there is nothing
 * to tick. Read per call, as the other virtual-agent settings are.
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
    if (!isAlwaysOn(name) && !options.some((option) => option.name === name)) {
      options.push({ name, description });
    }
  }
  return options;
}

export type CheckedPlugins = { ok: true; plugins: string[] } | { ok: false; error: string };

/**
 * A form that sends none ticks none. Otherwise each value has to be one of `allowed` or always on, and what is kept is
 * the distinct names in code-point order, leaving out the always-on ones, so the same set is always stored, and passed
 * to the pod, the same way.
 *
 * `allowed` is a function because reading the hub's offer list can throw on a malformed `VIRTUAL_AGENT_PLUGINS`, and
 * nothing that ticks no plugins, or only always-on ones, needs the list to be readable. Creating a virtual agent is
 * the case that matters: every Assistant creates one, so evaluating the list eagerly failed people who had asked for
 * no plugins at all.
 */
export function checkPlugins(raw: unknown, allowed: () => readonly string[]): CheckedPlugins {
  if (raw === undefined || raw === null) {
    return { ok: true, plugins: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "plugins are a list of names" };
  }
  let offered: readonly string[] | undefined;
  const names = new Set<string>();
  for (const value of raw) {
    const name = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!PLUGIN_NAME.test(name)) {
      return { ok: false, error: "a plugin name is lowercase letters, digits and hyphens" };
    }
    if (isAlwaysOn(name)) {
      continue;
    }
    offered ??= allowed();
    if (!offered.includes(name)) {
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

/** The names that are the owner's choice, leaving out any always-on one a row still holds. */
export function tickedPlugins(stored: readonly string[]): string[] {
  return stored.filter((name) => !isAlwaysOn(name));
}

/**
 * What a claim hands the orchestrator for `AGENT_HUB_PLUGINS`: the stored names and the always-on ones, distinct and
 * in code-point order, so a row that still holds an always-on name gives the same list as one that does not. This is
 * transitional: it is kept until every pod's client loads `ALWAYS_ON_PLUGINS` itself, which a client shows by claiming
 * the `slides-always-on` feature.
 */
export function podPlugins(stored: readonly string[]): string[] {
  return [...new Set([...stored, ...ALWAYS_ON_PLUGINS])].sort(byCodePoint);
}

/** What is stored, which the database only checks is an array, as the names in it. */
export function storedPlugins(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}
