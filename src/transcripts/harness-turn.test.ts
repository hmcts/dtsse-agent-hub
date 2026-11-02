import { describe, expect, it } from "vitest";
import { HARNESS_TURN_PATTERN, IDE_CONTEXT_PATTERN, isHarnessTurn, isTypedPrompt, typedText, WORDS_PATTERN, withoutIdeContext } from "./harness-turn.ts";

const IDE = "<ide_opened_file>The user opened the file /a/b.ts in the IDE.</ide_opened_file>";

describe("the patterns the migrations copy into SQL", () => {
  // Every code point a UTF-16 string can hold one unit of; no code point above it is whitespace to either engine.
  const BMP = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code));

  it("should read as words exactly the characters JavaScript's \\S does when tried on every code point", () => {
    const words = new RegExp(WORDS_PATTERN);
    expect(BMP.filter((character) => words.test(character) !== /\S/.test(character))).toEqual([]);
  });

  it("should read as whitespace exactly the characters trim removes when tried on every code point", () => {
    const words = new RegExp(WORDS_PATTERN);
    expect(BMP.filter((character) => words.test(character) === (character.trim() === ""))).toEqual([]);
  });

  it("should use no shorthand class, dot or lazy quantifier when a pattern is written, since Postgres reads those differently", () => {
    for (const pattern of [HARNESS_TURN_PATTERN, IDE_CONTEXT_PATTERN, WORDS_PATTERN]) {
      expect(pattern.replaceAll("[\\s\\S]", "")).not.toMatch(/\\[sSdDwW]|(?<!\\)\.|[*+?}]\?/);
    }
  });
});

describe("isHarnessTurn", () => {
  it.each([
    "<command-message>clear</command-message>",
    "<command-args></command-args>",
    "<system-reminder>x</system-reminder>",
    "<bash-stdout>out</bash-stdout>",
    "<bash-stderr>err</bash-stderr>",
    "[Request interrupted by user for tool use]",
    "\u00a0\u2028<command-name>/clear</command-name>",
    "\ufeff<bash-input>ls</bash-input>"
  ])("should recognise a turn as written by the harness when it opens with %j", (text) => {
    expect(isHarnessTurn(text)).toBe(true);
  });

  it.each(["", "fix this", "x <command-name>", "\u0085<command-name>/clear</command-name>", "Request interrupted by user"])(
    "should not recognise a turn as written by the harness when it is %j, which opens with no harness tag",
    (text) => {
      expect(isHarnessTurn(text)).toBe(false);
    }
  );
});

describe("withoutIdeContext", () => {
  it("should stop each block at its first closing tag when the selection quotes one", () => {
    expect(withoutIdeContext("<ide_selection>a</ide_selection> my words </ide_selection>")).toBe("my words </ide_selection>");
  });

  it("should take every block off when blocks of either kind come in any order across lines", () => {
    expect(withoutIdeContext(`<ide_selection>x\n= 1</ide_selection>\n${IDE}\n<ide_selection>y</ide_selection> fix\nthis`)).toBe("fix\nthis");
  });

  it("should leave a block alone when it is never closed", () => {
    expect(withoutIdeContext("<ide_selection>x = 1")).toBe("<ide_selection>x = 1");
  });

  it("should leave a block alone when it follows the words", () => {
    expect(withoutIdeContext(`fix this ${IDE}`)).toBe(`fix this ${IDE}`);
  });
});

describe("isTypedPrompt", () => {
  it.each([
    ["words", "fix this", true],
    ["words after editor context", `${IDE}\nfix this`, true],
    ["nothing", "", false],
    ["whitespace JavaScript trims", " \u00a0\ufeff\u3000\n", false],
    ["editor context alone", `${IDE}\n<ide_selection>x</ide_selection>  `, false],
    ["a harness turn after editor context", `${IDE}<command-name>/clear</command-name>`, false],
    ["a shell command", "<bash-input>ls</bash-input>", false]
  ])("should judge whether the person typed it when the turn is %s", (_, text, typed) => {
    expect(isTypedPrompt(text)).toBe(typed);
  });
});

describe("typedText", () => {
  it("should answer the words after the editor context when the person typed some", () => {
    expect(typedText(`${IDE}\n  fix this `)).toBe("fix this");
  });

  it("should answer null when the turn is the harness's or only editor context", () => {
    expect(typedText("<command-name>/clear</command-name>")).toBeNull();
    expect(typedText(IDE)).toBeNull();
  });
});
