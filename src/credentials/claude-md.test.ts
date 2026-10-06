import { describe, expect, it } from "vitest";
import { checkClaudeMd, claudeMdLength, DEFAULT_CLAUDE_MD, MAX_CLAUDE_MD_BYTES, MAX_CLAUDE_MD_CHARACTERS } from "./claude-md.ts";

describe("DEFAULT_CLAUDE_MD", () => {
  it("should tell Claude where it is running when nothing is stored", () => {
    expect(DEFAULT_CLAUDE_MD).toBe("You are running in a pod in Preview and connected via the agent hub.");
  });

  it("should pass its own check when it is used as the default", () => {
    expect(checkClaudeMd(DEFAULT_CLAUDE_MD)).toEqual({ ok: true, value: DEFAULT_CLAUDE_MD });
  });

  it("should fit inside the byte limit when the character limit fits under Key Vault's", () => {
    expect(MAX_CLAUDE_MD_CHARACTERS).toBe(20_000);
    expect(MAX_CLAUDE_MD_BYTES).toBeLessThan(25 * 1024);
  });
});

describe("claudeMdLength", () => {
  it.each([
    ["", 0],
    ["abc", 3],
    ["é", 1],
    ["😀", 1],
    ["a\nb", 3]
  ])("should count %j as %d characters when it is measured", (text, expected) => {
    expect(claudeMdLength(text)).toBe(expected);
  });
});

describe("checkClaudeMd", () => {
  it("should keep markdown, surrounding whitespace, tabs and blank lines as written when the text is valid", () => {
    const text = "  # Me\n\n\t- I work on PCS\n- Use British English  \n";

    expect(checkClaudeMd(text)).toEqual({ ok: true, value: text });
  });

  it.each([
    ["CRLF", "one\r\ntwo\r\n"],
    ["a lone CR", "one\rtwo\n"]
  ])("should turn %s line endings into LF when a browser submits them", (_label, text) => {
    expect(checkClaudeMd(text)).toEqual({ ok: true, value: "one\ntwo\n" });
  });

  it("should accept non-English text and emoji when they fit the limits", () => {
    expect(checkClaudeMd("Gwasanaeth — ✓ 😀")).toEqual({ ok: true, value: "Gwasanaeth — ✓ 😀" });
  });

  it.each([
    ["an empty string", ""],
    ["only whitespace", " \n\t "],
    ["something that is not a string", 42],
    ["nothing", undefined]
  ])("should ask for text when given %s", (_label, raw) => {
    expect(checkClaudeMd(raw)).toEqual({ ok: false, error: "write your CLAUDE.md, or reset it to the default" });
  });

  it.each([
    ["NUL", "a\u0000b"],
    ["a bell", "a\u0007b"],
    ["a vertical tab", "a\u000bb"],
    ["a form feed", "a\u000cb"],
    ["an escape", "a\u001b[31mred"],
    ["DEL", "a\u007fb"],
    ["a C1 control", "a\u0085b"]
  ])("should refuse %s when the text holds a control character", (_label, raw) => {
    expect(checkClaudeMd(raw)).toEqual({ ok: false, error: "your CLAUDE.md can only hold printable text, tabs and new lines" });
  });

  it("should refuse a lone surrogate when the text is not valid UTF-16", () => {
    expect(checkClaudeMd("a\ud800b")).toEqual({ ok: false, error: "your CLAUDE.md is not valid text" });
  });

  it("should accept exactly the character limit when it is ASCII", () => {
    expect(checkClaudeMd("a".repeat(MAX_CLAUDE_MD_CHARACTERS)).ok).toBe(true);
  });

  it("should refuse one character over the limit when it is too long", () => {
    expect(checkClaudeMd("a".repeat(MAX_CLAUDE_MD_CHARACTERS + 1))).toEqual({ ok: false, error: "your CLAUDE.md is at most 20,000 characters" });
  });

  it("should count an emoji as one character when it measures the limit", () => {
    expect(checkClaudeMd("😀".repeat(MAX_CLAUDE_MD_BYTES / 4))).toEqual({ ok: true, value: "😀".repeat(MAX_CLAUDE_MD_BYTES / 4) });
  });

  it("should refuse text within the character limit when its UTF-8 bytes are over Key Vault's", () => {
    const text = "é".repeat(MAX_CLAUDE_MD_BYTES / 2 + 1);
    expect(claudeMdLength(text)).toBeLessThanOrEqual(MAX_CLAUDE_MD_CHARACTERS);

    expect(checkClaudeMd(text)).toMatchObject({ ok: false, error: expect.stringContaining("24,000 bytes") });
  });

  it("should never repeat the text when it refuses it", () => {
    const result = checkClaudeMd("private context\u0000");

    expect(JSON.stringify(result)).not.toContain("private context");
  });
});
