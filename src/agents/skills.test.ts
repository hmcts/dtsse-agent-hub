import { describe, expect, it } from "vitest";
import { matchSkills, pickSkill, type Skill, skillQuery, skillsChanged, storedSkills } from "./skills.ts";

describe("skillQuery", () => {
  it("should give the text after the slash when the caret is in a leading slash token", () => {
    expect(skillQuery("/", 1)).toBe("");
    expect(skillQuery("/cft-ex", 7)).toBe("cft-ex");
    expect(skillQuery("/cft-ex rest", 3)).toBe("cft-ex");
  });

  it("should give null when the message does not start with a slash or the caret is outside the token", () => {
    expect(skillQuery("", 0)).toBeNull();
    expect(skillQuery(" /cft", 5)).toBeNull();
    expect(skillQuery("hi /cft", 7)).toBeNull();
    expect(skillQuery("/cft rest", 9)).toBeNull();
    expect(skillQuery("/cft", 0)).toBeNull();
  });
});

describe("matchSkills", () => {
  const skills = [
    { name: "alpha", description: "Uses beta" },
    { name: "beta", description: "Second" },
    { name: "gamma", description: "" }
  ];

  it("should list every skill when the query is empty", () => {
    expect(matchSkills(skills, "").map((skill) => skill.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("should list name-prefix matches first and then description matches when the query matches both", () => {
    expect(matchSkills(skills, "BETA").map((skill) => skill.name)).toEqual(["beta", "alpha"]);
  });
});

describe("pickSkill", () => {
  it("should replace the leading token with the skill and a space when a skill is picked", () => {
    expect(pickSkill("/cf", "cft-explain")).toEqual({ body: "/cft-explain ", caret: 13 });
    expect(pickSkill("/cf what is X", "cft-explain")).toEqual({ body: "/cft-explain what is X", caret: 13 });
    expect(pickSkill("/cf\nnext line", "cft-explain")).toEqual({ body: "/cft-explain \nnext line", caret: 13 });
  });
});

describe("storedSkills", () => {
  it("should drop entries that are not valid skills when the stored value has them", () => {
    expect(
      storedSkills([
        { name: "ok", description: "fine" },
        { name: "Bad" },
        "x",
        null,
        { name: "no-description" },
        { name: "long", description: "d".repeat(301) }
      ])
    ).toEqual([
      { name: "long", description: "d".repeat(300) },
      { name: "no-description", description: "" },
      { name: "ok", description: "fine" }
    ]);
  });

  it("should give no skills when the stored value is not a list", () => {
    expect(storedSkills({})).toEqual([]);
    expect(storedSkills(null)).toEqual([]);
  });
});

describe("skillsChanged", () => {
  const A = { name: "a", description: "first" };
  const B = { name: "b", description: "second" };
  const STORED = [A, B];

  it("should be false when the reported list is the stored one", () => {
    expect(skillsChanged(STORED, [{ ...A }, { ...B }])).toBe(false);
    expect(skillsChanged([], [])).toBe(false);
  });

  it.each<[string, Skill[]]>([
    ["a skill was added", [A, B, { name: "c", description: "" }]],
    ["a skill was removed", [A]],
    ["a skill was replaced", [A, { name: "c", description: "second" }]],
    ["a description changed", [A, { name: "b", description: "changed" }]],
    ["the list was cleared", []]
  ])("should be true when %s", (_label, reported) => {
    expect(skillsChanged(STORED, reported)).toBe(true);
  });
});
