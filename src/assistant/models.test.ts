import { describe, expect, it } from "vitest";
import { CATALOGUE, DEFAULT_MODEL, isKnownModel, modelLabel } from "./models.ts";

describe("CATALOGUE", () => {
  it("should hold Sonnet and Opus once each, Sonnet first, in the shape the database checks", () => {
    const all = CATALOGUE.map((model) => model.id);

    expect(all).toEqual(["sonnet", "opus"]);
    expect(all[0]).toBe(DEFAULT_MODEL);
    for (const id of all) {
      expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });

  it("should name no version in a label or a description, because hai pins them", () => {
    for (const model of CATALOGUE) {
      expect(`${model.label} ${model.description}`).not.toMatch(/\d/);
    }
  });

  it.each([["sonnet"], ["opus"]])("should know %s when it is in the catalogue", (id) => {
    expect(isKnownModel(id)).toBe(true);
  });

  it.each([
    ["claude-sonnet-5-5"],
    ["eu.anthropic.claude-sonnet-5-5"],
    ["sonnet --dangerously-skip-permissions"],
    [""],
    [42],
    [null]
  ])("should not know %j when it is not a catalogue id", (id) => {
    expect(isKnownModel(id)).toBe(false);
  });
});

describe("modelLabel", () => {
  it("should label an id with its display name when it is known, and as itself when it is not", () => {
    expect(modelLabel("opus")).toBe("Opus");
    expect(modelLabel("haiku")).toBe("haiku");
  });
});
