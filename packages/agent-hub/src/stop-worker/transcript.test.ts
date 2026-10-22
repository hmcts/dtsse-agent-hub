import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractTranscriptText, readTranscriptSlice } from "./transcript.ts";

const line = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type, message: { role: type, content }, ...extra })}\n`;

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-transcript-"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("extractTranscriptText", () => {
  it("should keep only user and assistant text when the transcript also holds tools, thinking and sidechains", () => {
    // Arrange
    const jsonl = [
      line("user", "fix the bug"),
      line("assistant", [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Fixed it." },
        { type: "tool_use", name: "Bash" }
      ]),
      line("user", [{ type: "tool_result", content: "ok" }]),
      line("assistant", "sidechain", { isSidechain: true }),
      "{not json\n",
      `${JSON.stringify({ type: "attachment" })}\n`
    ].join("");

    // Act & Assert
    expect(extractTranscriptText(jsonl)).toBe("User: fix the bug\n\nAssistant: Fixed it.");
  });
});

describe("readTranscriptSlice", () => {
  it("should read from the offset to the last full line and reset when the file is truncated", () => {
    // Arrange
    const file = path.join(dir, "t.jsonl");
    fs.writeFileSync(file, line("user", "one") + line("assistant", "two"));

    // Act
    const first = readTranscriptSlice(file, 0);

    // Assert
    expect(first.text).toBe("User: one\n\nAssistant: two");
    expect(first.end).toBe(fs.statSync(file).size);

    // Arrange: a half-written line is left for the next pass.
    fs.appendFileSync(file, `${line("user", "three")}{"type":"assist`);

    // Act
    const second = readTranscriptSlice(file, first.end);

    // Assert
    expect(second.text).toBe("User: three");
    expect(second.end).toBe(fs.statSync(file).size - '{"type":"assist'.length);

    // Arrange: a shorter file is a different transcript, so reading starts again from 0.
    fs.writeFileSync(file, line("user", "fresh"));

    // Act & Assert
    expect(readTranscriptSlice(file, second.end).text).toBe("User: fresh");
  });

  it("should keep only the last 20 KB when the new material is larger", () => {
    // Arrange
    const file = path.join(dir, "big.jsonl");
    fs.writeFileSync(file, line("user", `START ${"x".repeat(30000)}`) + line("assistant", "END"));

    // Act
    const { text } = readTranscriptSlice(file, 0);

    // Assert
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20 * 1024);
    expect(text.endsWith("Assistant: END")).toBe(true);
    expect(text.includes("START")).toBe(false);
  });

  it("should report nothing when the file is missing, empty or holds no complete line", () => {
    // Arrange
    const partial = path.join(dir, "partial.jsonl");
    fs.writeFileSync(partial, '{"type":"user"');

    // Act & Assert
    expect(readTranscriptSlice(path.join(dir, "absent.jsonl"), 7)).toEqual({ text: "", touches: { repos: [], products: [] }, end: 7 });
    expect(readTranscriptSlice(partial, 0)).toEqual({ text: "", touches: { repos: [], products: [] }, end: 0 });
    // An offset past the end restarts the read, but the reported end stays where the caller was.
    expect(readTranscriptSlice(partial, 9999)).toEqual({ text: "", touches: { repos: [], products: [] }, end: 9999 });
  });
});
