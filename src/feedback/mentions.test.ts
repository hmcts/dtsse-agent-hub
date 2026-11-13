import { describe, expect, it } from "vitest";
import { MAX_MENTIONS, mentionsIn } from "./mentions.ts";

const ANN = { oid: "oid-ann", name: "Ann" };
const ANN_LEE = { oid: "oid-ann-lee", name: "Ann Lee" };
const ANNA = { oid: "oid-anna", name: "Anna" };
const BO = { oid: "oid-bo", name: "Bo Ng" };
const PEOPLE = [ANN, ANN_LEE, ANNA, BO];

describe("mentionsIn", () => {
  it("should find each person named once, in the order first named", () => {
    expect(mentionsIn("@bo ng and @Anna, then @Bo Ng again", PEOPLE)).toEqual([BO.oid, ANNA.oid]);
  });

  it("should prefer the longest name when one name starts another", () => {
    expect(mentionsIn("thanks @Ann Lee", PEOPLE)).toEqual([ANN_LEE.oid]);
    expect(mentionsIn("thanks @Ann!", PEOPLE)).toEqual([ANN.oid]);
  });

  it("should not match a name that runs on into more letters", () => {
    expect(mentionsIn("@Annabel", PEOPLE)).toEqual([]);
  });

  it("should not read an @ inside a word as a mention", () => {
    expect(mentionsIn("mail ann@Ann.example", PEOPLE)).toEqual([]);
  });

  it("should name nobody when no one is mentionable", () => {
    expect(mentionsIn("@Ann", [])).toEqual([]);
    expect(mentionsIn("@ hello", [{ oid: "blank", name: "  " }])).toEqual([]);
  });

  it("should stop at the most mentions one comment records", () => {
    const many = Array.from({ length: MAX_MENTIONS + 5 }, (_, index) => ({ oid: `oid-${index}`, name: `Person${index}` }));

    expect(mentionsIn(many.map((person) => `@${person.name}`).join(" "), many)).toHaveLength(MAX_MENTIONS);
  });
});
