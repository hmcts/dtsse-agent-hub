import { describe, expect, it, vi } from "vitest";
import { availablePlugins, checkPlugins, MAX_PLUGINS, PluginConfigurationError, samePlugins, storedPlugins } from "./plugins.ts";

describe("availablePlugins", () => {
  it.each([{}, { VIRTUAL_AGENT_PLUGINS: "" }, { VIRTUAL_AGENT_PLUGINS: " , ," }])("should offer none when the variable is %j", (env) => {
    expect(availablePlugins(env)).toEqual([]);
  });

  it("should read names with and without descriptions in the order given when the variable lists them", () => {
    expect(availablePlugins({ VIRTUAL_AGENT_PLUGINS: " pcs = PCS team workflows , dtsse,wa=Work allocation = tasks" })).toEqual([
      { name: "pcs", description: "PCS team workflows" },
      { name: "dtsse", description: "" },
      { name: "wa", description: "Work allocation = tasks" }
    ]);
  });

  it("should keep the first entry when a name is repeated", () => {
    expect(availablePlugins({ VIRTUAL_AGENT_PLUGINS: "pcs=first,pcs=second" })).toEqual([{ name: "pcs", description: "first" }]);
  });

  it.each(["PCS", "-pcs", "pcs team", "=no name", "pcs/x"])("should refuse the configuration when it names %j", (entry) => {
    expect(() => availablePlugins({ VIRTUAL_AGENT_PLUGINS: `dtsse,${entry}` })).toThrow(PluginConfigurationError);
  });
});

describe("checkPlugins", () => {
  const OFFERED = ["dtsse", "pcs", "wa"];

  it.each([[undefined], [null], [[]]])("should tick none when the form sends %j", (raw) => {
    expect(checkPlugins(raw, () => OFFERED)).toEqual({ ok: true, plugins: [] });
  });

  it("should keep each name once, in code-point order, when the form sends them in any order and case", () => {
    expect(checkPlugins(["wa", " PCS ", "dtsse", "pcs"], () => OFFERED)).toEqual({ ok: true, plugins: ["dtsse", "pcs", "wa"] });
  });

  it("should refuse a name the hub does not offer", () => {
    expect(checkPlugins(["pcs", "civil"], () => OFFERED)).toEqual({ ok: false, error: "civil is not a plugin this hub offers" });
  });

  it.each([[["pcs team"]], [[""]], [[3]], [[{}]]])("should refuse %j when it is not a list of plugin names", (raw) => {
    expect(checkPlugins(raw, () => OFFERED)).toEqual({ ok: false, error: "a plugin name is lowercase letters, digits and hyphens" });
  });

  it.each(["pcs", { pcs: true }])("should refuse %j when it is not a list", (raw) => {
    expect(checkPlugins(raw, () => OFFERED)).toEqual({ ok: false, error: "plugins are a list of names" });
  });

  it("should refuse more than the most an agent may have when they are all offered", () => {
    const many = Array.from({ length: MAX_PLUGINS + 1 }, (_, index) => `p-${index}`);

    expect(checkPlugins(many, () => many)).toEqual({ ok: false, error: `a virtual agent has at most ${MAX_PLUGINS} plugins` });
    expect(checkPlugins(many.slice(1), () => many)).toMatchObject({ ok: true });
  });

  // Creating any virtual agent checks its plugins, so reading an offer list that throws would fail everyone who
  // ticked none — which is everyone whose assistant is created for them.
  it.each([[undefined], [null], [[]]])("should not read the hub's offer list at all when the form sends %j", (raw) => {
    const offered = vi.fn(() => {
      throw new PluginConfigurationError('VIRTUAL_AGENT_PLUGINS has "Not A Plugin Name", which is not a plugin name');
    });

    expect(checkPlugins(raw, offered)).toEqual({ ok: true, plugins: [] });
    expect(offered).not.toHaveBeenCalled();
  });

  it("should read the hub's offer list, and fail with it, once a name is actually ticked", () => {
    const offered = () => {
      throw new PluginConfigurationError('VIRTUAL_AGENT_PLUGINS has "Not A Plugin Name", which is not a plugin name');
    };

    expect(() => checkPlugins(["pcs"], offered)).toThrow(PluginConfigurationError);
  });

  it("should not read the hub's offer list when the form sends something that is not a list", () => {
    const offered = vi.fn(() => OFFERED);

    expect(checkPlugins("pcs", offered)).toEqual({ ok: false, error: "plugins are a list of names" });
    expect(offered).not.toHaveBeenCalled();
  });
});

describe("samePlugins", () => {
  it("should compare two sorted lists name by name", () => {
    expect(samePlugins(["dtsse", "pcs"], ["dtsse", "pcs"])).toBe(true);
    expect(samePlugins(["dtsse", "pcs"], ["dtsse"])).toBe(false);
    expect(samePlugins([], [])).toBe(true);
  });
});

describe("storedPlugins", () => {
  it("should read the names out of what is stored and nothing else when the column holds other values", () => {
    expect(storedPlugins(["dtsse", "pcs"])).toEqual(["dtsse", "pcs"]);
    expect(storedPlugins(["pcs", 3, null])).toEqual(["pcs"]);
    expect(storedPlugins({})).toEqual([]);
  });
});
