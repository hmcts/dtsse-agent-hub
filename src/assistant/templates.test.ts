import { describe, expect, it } from "vitest";
import { TEMPLATES } from "./starters.ts";
import {
  checkTemplate,
  MAX_TEMPLATE_BODY,
  MAX_TEMPLATE_NAME,
  MAX_TEMPLATES,
  offeredTemplates,
  TEMPLATES_FULL,
  templateLength,
  templateNameTaken
} from "./templates.ts";

function refusal(input: { name: unknown; body: unknown }): string | undefined {
  const checked = checkTemplate(input);
  return checked.ok ? undefined : checked.error;
}

describe("checkTemplate", () => {
  it("should keep the trimmed name and the body when both are within the caps", () => {
    expect(checkTemplate({ name: "  Stand-up  ", body: "What I did yesterday:\n- …" })).toEqual({
      ok: true,
      template: { name: "Stand-up", text: "What I did yesterday:\n- …" }
    });
  });

  it("should turn a browser's CRLF newlines into line feeds when the body is submitted from a textarea", () => {
    const checked = checkTemplate({ name: "Bugfix", body: "one\r\ntwo\rthree" });

    expect(checked.ok ? checked.template.text : undefined).toBe("one\ntwo\nthree");
  });

  it("should trim the blank lines around a pasted body, so the message box does not open on an empty line", () => {
    const checked = checkTemplate({ name: "Spike note", body: "\n\n  Question to answer: …\n\n  " });

    expect(checked.ok ? checked.template.text : undefined).toBe("Question to answer: …");
  });

  it.each([
    ["a name of only spaces", { name: "   ", body: "x" }, "give your template a name"],
    ["something that is not a name at all", { name: 7, body: "x" }, "give your template a name"],
    ["a name past the cap", { name: "n".repeat(MAX_TEMPLATE_NAME + 1), body: "x" }, `at most ${MAX_TEMPLATE_NAME} characters`],
    ["an empty body", { name: "Mine", body: "  \n " }, "write the prompt"],
    ["a body that is not text", { name: "Mine", body: null }, "write the prompt"],
    ["a body past the cap", { name: "Mine", body: "b".repeat(MAX_TEMPLATE_BODY + 1) }, "at most 4,000 characters"],
    ["a body holding a NUL", { name: "Mine", body: "a\u0000b" }, "printable text"],
    ["a name holding a lone surrogate", { name: "Mine\ud800", body: "x" }, "printable text"]
  ])("should refuse %s", (_label, input, error) => {
    expect(refusal(input)).toContain(error);
  });

  // Nobody shadows a built-in without being told; `offeredTemplates` is what keeps the menu's names distinct.
  it("should refuse a name one of the built-in templates already uses", () => {
    expect(refusal({ name: TEMPLATES[0]?.name, body: "mine" })).toBe(`"${TEMPLATES[0]?.name}" is one of the built-in templates; give yours another name`);
  });

  it("should collapse a name's own runs of whitespace, since a name is one line in a menu", () => {
    const checked = checkTemplate({ name: " Daily\t stand-up \n note ", body: "x" });

    expect(checked.ok ? checked.template.name : undefined).toBe("Daily stand-up note");
  });

  // Without the collapse this is a different string from the built-in name while rendering identically to it, so the
  // clash check waves it through and the menu gets two items a person cannot tell apart.
  it("should refuse a built-in's name written with a tab in it, which renders the same as the built-in", () => {
    expect(refusal({ name: "New\tfeature", body: "mine" })).toContain("one of the built-in templates");
  });

  it("should allow a body of exactly the cap, counted as a person counts it", () => {
    expect(checkTemplate({ name: "Emoji", body: "🙂".repeat(MAX_TEMPLATE_BODY) }).ok).toBe(true);
  });

  it("should refuse one emoji past the cap, which String.length alone would have refused at half of it", () => {
    expect(refusal({ name: "Emoji", body: "🙂".repeat(MAX_TEMPLATE_BODY + 1) })).toContain("at most 4,000 characters");
  });
});

describe("the refusals the store words", () => {
  it("should name the cap and what to do about it when a person is at it", () => {
    expect(TEMPLATES_FULL).toBe(`you already have ${MAX_TEMPLATES} templates; delete one to make room`);
  });

  it("should name the template when the person already has one of that name", () => {
    expect(templateNameTaken("Stand-up")).toBe(`you already have a template called "Stand-up"`);
  });
});

describe("templateLength", () => {
  it("should count an emoji as one character, the way Postgres char_length does", () => {
    expect(templateLength("a🙂b")).toBe(3);
  });
});

describe("offeredTemplates", () => {
  it("should offer the person's own first and then every built-in one when they have some saved", () => {
    const mine = [{ name: "Stand-up", text: "…" }];

    expect(offeredTemplates(mine).map((template) => template.name)).toEqual(["Stand-up", ...TEMPLATES.map((template) => template.name)]);
  });

  it("should offer the built-in templates alone when the person has saved none", () => {
    expect(offeredTemplates([])).toEqual([...TEMPLATES]);
  });

  /**
   * The property, not an example. `checkTemplate` refuses a name a built-in holds at the time of saving, so the only
   * way into a clash is a built-in being renamed into a name somebody has already saved — which no check can reach
   * back and prevent. These assert the property over exactly that: a saved template per built-in name.
   */
  it("should give every offered template a distinct name, whatever the person has saved", () => {
    const mine = TEMPLATES.map((built, index) => ({ name: built.name, text: `mine ${index}` }));

    const names = offeredTemplates([...mine, { name: "Stand-up", text: "…" }]).map((template) => template.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it("should keep the person's own, not the built-in one, when a rename has put the two names together", () => {
    const clashing = TEMPLATES[2]!;
    const mine = [{ name: clashing.name, text: "mine, not the built-in one" }];

    const offered = offeredTemplates(mine);

    expect(offered.filter((template) => template.name === clashing.name)).toEqual(mine);
    expect(offered).toHaveLength(TEMPLATES.length);
  });
});
