import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, isModel, MODELS, modelLabel, storedModel } from "./models.ts";

describe("models", () => {
  it("should default to Sonnet 5.5 when nothing has been picked", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5-5");
    expect(isModel(DEFAULT_MODEL)).toBe(true);
    expect(MODELS[0]?.id).toBe(DEFAULT_MODEL);
  });

  it("should offer each id once when the list is built", () => {
    const ids = MODELS.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("should fit every id in the database's model check when it is stored", () => {
    for (const model of MODELS) {
      expect(model.id).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });

  it.each([["claude-sonnet-5-5"], ["claude-opus-5-5"], ["claude-haiku-5-5"]])("should accept %s when it is offered", (id) => {
    expect(isModel(id)).toBe(true);
  });

  it.each([
    ["claude-fable-5-1"],
    ["eu.anthropic.claude-sonnet-5-5"],
    ["claude-sonnet-5-5[1m]"],
    ["CLAUDE-SONNET-5-5"],
    ["sonnet"],
    ["claude-sonnet-5-5 --dangerously-skip-permissions"],
    [""],
    [42],
    [null]
  ])("should refuse %j when it is not an offered id", (id) => {
    expect(isModel(id)).toBe(false);
  });

  it("should stand an id no longer offered for the default when it is read back", () => {
    expect(storedModel("claude-sonnet-4-6")).toBe(DEFAULT_MODEL);
    expect(storedModel("claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  it("should label an id with its display name when it is offered, and as itself when it is not", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-retired-1")).toBe("claude-retired-1");
  });
});
