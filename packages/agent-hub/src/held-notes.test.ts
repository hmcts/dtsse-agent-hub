// The queue the stop worker appends feed notes to and the UserPromptContext hook drains. The workspace suite's
// last three cases drove the hook itself through `runHook`, so they are in `hooks.test.ts` rather than restated
// here, and what the CLI prints for that hook is in `cli.test.ts`.
import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import { HELD_NOTES, heldNotesContext, holdNote, MAX_HELD_BYTES, MAX_HELD_NOTES, messageIds, parseHeldNote, takeHeldNotes } from "./held-notes.ts";
import { ensureStateDir, statePath } from "./session.ts";

const SID = "sess-held-notes";

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = tempClaudeHome();
  for (const [key, value] of Object.entries(home.env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  home.cleanup();
});

beforeEach(() => {
  fs.rmSync(home.hub, { recursive: true, force: true });
  ensureStateDir(SID);
  fs.writeFileSync(statePath(SID, "enabled"), "x");
});

const queue = () => statePath(SID, HELD_NOTES);

describe("messageIds", () => {
  it("should pull the #<id> references out of a note once each when one is repeated", () => {
    // Act & Assert
    expect(messageIds("#50 and #7 relate to #50")).toEqual(["50", "7"]);
  });

  it("should be empty when the note cites nothing", () => {
    // Act & Assert
    expect(messageIds("nothing cited")).toEqual([]);
  });
});

describe("holdNote", () => {
  it("should append one JSON line per note with its time and message ids when notes are held", () => {
    // Act
    holdNote(SID, "#12 renames the table", Date.UTC(2026, 9, 9));
    holdNote(SID, "a note with no id", Date.UTC(2026, 9, 9, 1));

    // Assert
    const lines = fs
      .readFileSync(queue(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { at: "2026-10-09T00:00:00.000Z", text: "#12 renames the table", message_ids: ["12"] },
      { at: "2026-10-09T01:00:00.000Z", text: "a note with no id" }
    ]);
  });

  it("should keep only the newest notes by count when more than the maximum are held", () => {
    // Act
    for (let i = 0; i < MAX_HELD_NOTES + 5; i++) {
      holdNote(SID, `note ${i}`);
    }

    // Assert
    const notes = takeHeldNotes(SID);
    expect(notes).toHaveLength(MAX_HELD_NOTES);
    expect(notes[0]?.text).toBe("note 5");
    expect(notes.at(-1)?.text).toBe(`note ${MAX_HELD_NOTES + 4}`);
  });

  it("should keep only the newest notes by size when the queue would outgrow its byte budget", () => {
    // Act
    for (let i = 0; i < 10; i++) {
      holdNote(SID, `${i} ${"x".repeat(1900)}`);
    }

    // Assert
    expect(fs.statSync(queue()).size).toBeLessThanOrEqual(MAX_HELD_BYTES);
    const notes = takeHeldNotes(SID);
    expect(notes.length).toBeLessThan(10);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.at(-1)?.text).toMatch(/^9 /);
  });
});

describe("takeHeldNotes", () => {
  it("should empty the queue and start a new one when a note arrives during the take", () => {
    // Arrange
    holdNote(SID, "first");
    const realRead = fs.readFileSync;
    // Simulates the stop worker appending between the rename and the read.
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (String(file).endsWith(".taking")) {
        spy.mockRestore();
        holdNote(SID, "arrived during the take");
      }
      return realRead(file, options as Parameters<typeof realRead>[1]);
    });

    // Act & Assert
    try {
      expect(takeHeldNotes(SID).map((n) => n.text)).toEqual(["first"]);
    } finally {
      spy.mockRestore();
    }
    expect(takeHeldNotes(SID).map((n) => n.text)).toEqual(["arrived during the take"]);
    expect(takeHeldNotes(SID)).toEqual([]);
    expect(fs.readdirSync(statePath(SID, ".")).filter((f) => f.startsWith(HELD_NOTES))).toEqual([]);
  });

  it("should skip lines that are not notes when the queue has been corrupted", () => {
    // Arrange
    fs.writeFileSync(queue(), '{not json\n{"text":""}\n{"at":"t","text":"kept"}\n');

    // Act & Assert
    expect(takeHeldNotes(SID)).toEqual([{ at: "t", text: "kept" }]);
  });

  it("should be empty when there is no queue", () => {
    // Act & Assert
    expect(takeHeldNotes(SID)).toEqual([]);
  });
});

describe("parseHeldNote", () => {
  it("should be null when the value is not a note with text in it", () => {
    // Act & Assert
    for (const value of [null, 7, "x", [], {}, { text: "  " }, { text: 7 }]) {
      expect(parseHeldNote(value)).toBeNull();
    }
  });

  it("should drop a time and message ids that are not what they should be when a note is malformed", () => {
    // Act & Assert
    expect(parseHeldNote({ at: 7, text: "x", message_ids: "12" })).toEqual({ text: "x" });
    expect(parseHeldNote({ at: "t", text: "x", message_ids: ["12", 13] })).toEqual({ at: "t", text: "x", message_ids: ["12"] });
  });
});

describe("heldNotesContext", () => {
  it("should say the notes are not from the user, when to stay silent and how to read them when notes are held", () => {
    // Act
    const text = heldNotesContext([{ at: "2026-10-09T00:00:00.000Z", text: "#55 changes the schema you are editing." }]);

    // Assert
    expect(text).toMatch(/NOT from the user/);
    expect(text).toMatch(/ignore them silently/);
    expect(text).toMatch(/scripts\/agent-hub read <id>/);
    expect(text).toMatch(/scripts\/agent-hub reply <id> "<text>"/);
    expect(text.endsWith("- (2026-10-09T00:00:00.000Z) #55 changes the schema you are editing.")).toBe(true);
  });

  it("should date a note as earlier when it carries no time", () => {
    // Act & Assert
    expect(heldNotesContext([{ text: "undated" }]).endsWith("- (earlier) undated")).toBe(true);
  });
});
