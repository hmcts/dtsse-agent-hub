import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentDisposition, clip, fileName } from "./downloads.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clip", () => {
  it("should keep text at or under the limit as it is", () => {
    expect(clip("abc", 3)).toBe("abc");
  });

  it("should leave out a grapheme that would cross the limit rather than cut it, when it is an emoji with a modifier", () => {
    expect(clip(`ab👍🏽`, 4)).toBe("ab");
    expect(clip(`ab👍🏽c`, 6)).toBe("ab👍🏽");
  });

  it("should cut on code points, never inside a surrogate pair, when the runtime has no grapheme segmenter", () => {
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    expect(clip(`ab😀`, 3)).toBe("ab");
    expect(clip(`ab😀c`, 4)).toBe("ab😀");
  });
});

describe("fileName", () => {
  it("should leave the emoji out whole, and give a name the disposition can encode, when 79 ASCII characters come before it", () => {
    const name = fileName(`${"a".repeat(79)}😀 and more`, "pptx");

    expect(name).toBe(`${"a".repeat(79)}.pptx`);
    expect(() => attachmentDisposition(name)).not.toThrow();
  });

  it("should keep an emoji that fits inside the limit", () => {
    expect(fileName(`${"a".repeat(78)}😀 and more`, "md")).toBe(`${"a".repeat(78)}😀.md`);
  });
});

describe("attachmentDisposition", () => {
  it("should percent-encode the four characters encodeURIComponent leaves that RFC 5987 does not allow", () => {
    expect(attachmentDisposition("Team's plan (draft) *.pptx")).toBe(
      `attachment; filename="Team's plan (draft) *.pptx"; filename*=UTF-8''Team%27s%20plan%20%28draft%29%20%2A.pptx`
    );
  });

  it("should keep the characters RFC 5987 allows, and give an ASCII stand-in for the rest, when the name has accents and quotes", () => {
    expect(attachmentDisposition('Plan "Q4" é!~.pptx')).toBe(`attachment; filename="Plan _Q4_ _!~.pptx"; filename*=UTF-8''Plan%20%22Q4%22%20%C3%A9!~.pptx`);
  });

  it("should send half a surrogate pair as U+FFFD rather than throw, when a stored name holds one", () => {
    expect(attachmentDisposition("ab\ud83d.xlsx")).toBe(`attachment; filename="ab_.xlsx"; filename*=UTF-8''ab%EF%BF%BD.xlsx`);
  });
});
