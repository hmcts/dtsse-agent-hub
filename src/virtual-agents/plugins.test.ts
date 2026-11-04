import { describe, expect, it, vi } from "vitest";
import {
  ALWAYS_ON_PLUGINS,
  availablePlugins,
  checkPlugins,
  isAlwaysOn,
  MAX_PLUGINS,
  PluginConfigurationError,
  podPlugins,
  samePlugins,
  storedPlugins,
  tickedPlugins
} from "./plugins.ts";

describe("ALWAYS_ON_PLUGINS", () => {
  it("should hold slides and not welsh", () => {
    expect(ALWAYS_ON_PLUGINS).toEqual(["slides"]);
    expect(isAlwaysOn("slides")).toBe(true);
    expect(isAlwaysOn("welsh")).toBe(false);
  });

  it("should be the pod client's own list when the hub adds it to a claim", async () => {
    // Two copies, because the hub does not depend on the client package: the hub's decides what a claim carries, and
    // the client's what a pod loads. Imported by URL so that the hub's typecheck does not take in the client's sources.
    const client: { ALWAYS_ON_PLUGINS: readonly string[] } = await import(
      new URL("../../packages/agent-hub/src/virtual/bundled-plugins.ts", import.meta.url).href
    );
    expect(ALWAYS_ON_PLUGINS).toEqual(client.ALWAYS_ON_PLUGINS);
  });
});

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

  it("should not offer slides when the configuration still names it", () => {
    expect(availablePlugins({ VIRTUAL_AGENT_PLUGINS: "welsh=Welsh translations,slides=HMCTS slide decks" })).toEqual([
      { name: "welsh", description: "Welsh translations" }
    ]);
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

  it("should accept slides and store it no more when the form sends it, though the hub does not offer it", () => {
    expect(checkPlugins(["slides", "pcs"], () => OFFERED)).toEqual({ ok: true, plugins: ["pcs"] });
    expect(checkPlugins(["slides"], () => OFFERED)).toEqual({ ok: true, plugins: [] });
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

  it("should not read the hub's offer list when the form sends only always-on plugins", () => {
    const offered = vi.fn(() => {
      throw new PluginConfigurationError('VIRTUAL_AGENT_PLUGINS has "Not A Plugin Name", which is not a plugin name');
    });

    expect(checkPlugins(["slides"], offered)).toEqual({ ok: true, plugins: [] });
    expect(offered).not.toHaveBeenCalled();
  });

  it("should read the hub's offer list once however many names are ticked", () => {
    const offered = vi.fn(() => OFFERED);

    expect(checkPlugins(["slides", "pcs", "dtsse"], offered)).toEqual({ ok: true, plugins: ["dtsse", "pcs"] });
    expect(offered).toHaveBeenCalledTimes(1);
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

describe("tickedPlugins", () => {
  it("should leave out an always-on name a row still holds and keep the rest in order", () => {
    expect(tickedPlugins(["pcs", "slides", "welsh"])).toEqual(["pcs", "welsh"]);
    expect(tickedPlugins(["slides"])).toEqual([]);
    expect(tickedPlugins([])).toEqual([]);
  });
});

describe("podPlugins", () => {
  it("should add slides to what is stored, once and in code-point order", () => {
    expect(podPlugins([])).toEqual(["slides"]);
    expect(podPlugins(["pcs", "welsh"])).toEqual(["pcs", "slides", "welsh"]);
  });

  it("should give the same list when a row still holds slides", () => {
    expect(podPlugins(["pcs", "slides"])).toEqual(podPlugins(["pcs"]));
  });
});

describe("storedPlugins", () => {
  it("should read the names out of what is stored and nothing else when the column holds other values", () => {
    expect(storedPlugins(["dtsse", "pcs"])).toEqual(["dtsse", "pcs"]);
    expect(storedPlugins(["pcs", 3, null])).toEqual(["pcs"]);
    expect(storedPlugins({})).toEqual([]);
  });
});
