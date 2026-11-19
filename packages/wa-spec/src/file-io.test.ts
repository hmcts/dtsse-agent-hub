import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exists, isDirectory, listDir, readText, removeFile, writeText } from "./file-io.ts";

describe("file-io", () => {
  it("should create the directories above a file and read it back when it is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-spec-io-"));
    const path = join(dir, "a", "b", "c.txt");
    expect(exists(path)).toBe(false);
    writeText(path, "hello");
    expect(exists(path)).toBe(true);
    expect(readText(path)).toBe("hello");
    expect(isDirectory(join(dir, "a"))).toBe(true);
    expect(isDirectory(path)).toBe(false);
    expect(listDir(join(dir, "a", "b"))).toEqual(["c.txt"]);
    removeFile(path);
    expect(exists(path)).toBe(false);
  });
});
