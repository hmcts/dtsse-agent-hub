import { describe, expect, it } from "vitest";
import { CATALOGUE, DEFAULT_MODEL, isKnownModel, isOffered, type ModelStatus, modelLabel, modelOffer, storedModel } from "./models.ts";

const ids = (offer: { models: { id: string }[] }) => offer.models.map((model) => model.id);
const answers = (entries: [string, ModelStatus][]) => new Map(entries);

describe("CATALOGUE", () => {
  it("should hold each id once, Sonnet 5.5 first, in the shape the database checks", () => {
    const all = CATALOGUE.map((model) => model.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all[0]).toBe(DEFAULT_MODEL);
    expect(all).toContain("claude-fable-5-1");
    for (const id of all) {
      expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });

  it.each([["claude-opus-5-5"], ["claude-fable-5-1"]])("should know %s when it is in the catalogue", (id) => {
    expect(isKnownModel(id)).toBe(true);
  });

  it.each([
    ["eu.anthropic.claude-sonnet-5-5"],
    ["claude-sonnet-5-5 --dangerously-skip-permissions"],
    [""],
    [42],
    [null]
  ])("should not know %j when it is not a catalogue id", (id) => {
    expect(isKnownModel(id)).toBe(false);
  });
});

describe("modelOffer", () => {
  it("should offer only Sonnet 5.5 when no check has finished or the pod cannot check", () => {
    expect(modelOffer(undefined)).toEqual({ models: [CATALOGUE[0]], defaultModel: DEFAULT_MODEL });
    expect(modelOffer(new Map())).toEqual({ models: [CATALOGUE[0]], defaultModel: DEFAULT_MODEL });
  });

  it("should offer the models that answered, in catalogue order, when a check has", () => {
    const offer = modelOffer(
      answers([
        ["claude-haiku-5-5", "available"],
        ["claude-fable-5-1", "unavailable"],
        ["claude-sonnet-5-5", "available"],
        ["claude-opus-5-5", "available"]
      ])
    );

    expect(ids(offer)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
    expect(offer.defaultModel).toBe(DEFAULT_MODEL);
  });

  it("should default to the first that answered when Sonnet 5.5 did not", () => {
    const offer = modelOffer(
      answers([
        ["claude-sonnet-5-5", "unavailable"],
        ["claude-haiku-5-5", "available"],
        ["claude-fable-5-1", "available"]
      ])
    );

    expect(ids(offer)).toEqual(["claude-haiku-5-5", "claude-fable-5-1"]);
    expect(offer.defaultModel).toBe("claude-haiku-5-5");
  });

  it("should offer Sonnet 5.5 anyway when nothing answered", () => {
    expect(modelOffer(answers([["claude-sonnet-5-5", "unavailable"]]))).toEqual({ models: [CATALOGUE[0]], defaultModel: DEFAULT_MODEL });
  });

  it("should ignore an answer for a model the catalogue no longer holds", () => {
    expect(ids(modelOffer(answers([["claude-retired-1", "available"]])))).toEqual([DEFAULT_MODEL]);
  });
});

describe("storedModel", () => {
  const offer = modelOffer(
    answers([
      ["claude-opus-5-5", "available"],
      ["claude-haiku-5-5", "available"]
    ])
  );

  it("should keep a stored model when it is still offered", () => {
    expect(storedModel(offer, "claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(isOffered(offer, "claude-haiku-5-5")).toBe(true);
  });

  it("should stand a stored model for the default when it is no longer offered", () => {
    expect(storedModel(offer, "claude-sonnet-5-5")).toBe("claude-opus-5-5");
    expect(isOffered(offer, "claude-sonnet-5-5")).toBe(false);
    expect(isOffered(offer, 7)).toBe(false);
  });
});

describe("modelLabel", () => {
  it("should label an id with its display name when it is known, and as itself when it is not", () => {
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-retired-1")).toBe("claude-retired-1");
  });
});
