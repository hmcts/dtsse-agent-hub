import { describe, expect, it } from "vitest";
import { formatFromNote, noteFor } from "./hints.ts";
import type { Line } from "./pdf-extract.ts";

const line = (text: string, y: number, over: Partial<Line> = {}): Line => ({ page: 1, x0: 428, x1: 540, y, height: 10, text, ...over });

describe("noteFor", () => {
  const lines = [
    line("Note 1.1", 777),
    line("CICA reference numbers", 759),
    line("begin with the letter X or G.", 746),
    line("Note 1.2", 730),
    line("Something else entirely.", 715)
  ];

  it("should join the lines under the note when the question has one", () => {
    expect(noteFor("1.2", lines, 1)).toBe("Something else entirely.");
  });

  it("should stop at the next note when two notes are adjacent, so one question never takes another's words", () => {
    expect(noteFor("1.1", lines, 1)).toBe("CICA reference numbers begin with the letter X or G.");
  });

  it("should find no note when the question is on another page than the note", () => {
    expect(noteFor("1.1", lines, 2)).toBeUndefined();
  });
});

describe("formatFromNote", () => {
  it("should read the letters when a note says a number begins with them", () => {
    expect(formatFromNote("Numbers begin with the letter X or G.")).toMatchObject({ regex: "^[XG].*" });
    expect(formatFromNote("Use black ink.")).toBeUndefined();
  });
});
