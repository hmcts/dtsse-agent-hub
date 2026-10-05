import { describe, expect, it } from "vitest";
import { createLogger, describeError, oneLine } from "./log.ts";

const AT = new Date("2026-10-05T12:00:00Z");

function capture() {
  const lines: string[] = [];
  return {
    lines,
    log: createLogger(
      (line) => lines.push(line),
      () => AT
    )
  };
}

describe("createLogger", () => {
  it("should write one JSON object per call with the time, level and message", () => {
    const { lines, log } = capture();

    log("info", "applied", { id: "a", generation: 2 });

    expect(lines).toEqual([JSON.stringify({ id: "a", generation: 2, time: AT.toISOString(), level: "info", message: "applied" })]);
  });

  it("should remove line breaks from the message and from every string field, however deep, when they hold untrusted text", () => {
    const { lines, log } = capture();

    log("error", "could not\r\napply", { error: "bad\nline", nested: { list: ["a b"], "k\ne": 1 }, none: null });

    const [line] = lines;
    expect(line).not.toMatch(/\\[rn]|\\u2028/);
    expect(JSON.parse(line!)).toMatchObject({ message: "could not  apply", error: "bad line", nested: { list: ["a b"], "k e": 1 }, none: null });
  });

  it("should not let a field overwrite the time, level or message when it has the same name", () => {
    const { lines, log } = capture();

    log("warn", "pass", { level: "info", message: "forged", time: "then" });

    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", message: "pass", time: AT.toISOString() });
  });

  it("should default to no fields", () => {
    const { lines, log } = capture();

    log("info", "started");

    expect(JSON.parse(lines[0]!)).toEqual({ time: AT.toISOString(), level: "info", message: "started" });
  });

  it("should write to stdout on the system clock when given nothing", () => {
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => writes.push(chunk) > 0) as typeof process.stdout.write;
    try {
      createLogger()("info", "hello");
    } finally {
      process.stdout.write = original;
    }

    expect(writes[0]).toMatch(/"message":"hello"\}\n$/);
  });
});

describe("describeError", () => {
  it.each([
    ["an Error", new Error("one\ntwo"), "one two"],
    ["a thrown string", "three\rfour", "three four"]
  ])("should give the message on one line when it is %s", (_label, error, expected) => {
    expect(describeError(error)).toBe(expected);
  });
});

describe("oneLine", () => {
  it("should leave text without line breaks alone", () => {
    expect(oneLine("plain")).toBe("plain");
  });
});
